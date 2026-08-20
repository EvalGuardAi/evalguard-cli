/**
 * `evalguard compliance-check` — Run compliance checks against AI frameworks
 *
 * Checks an AI system's compliance against regulatory frameworks like the
 * EU AI Act, HIPAA, FedRAMP, PCI-DSS, ISO 42001, OWASP LLM Top 10, and NIST AI RMF.
 *
 * Works in two modes:
 *   - With API key: sends check to the EvalGuard API
 *   - Without API key: runs locally using @evalguard/core compliance engine
 *
 * Usage:
 *   evalguard compliance-check --framework eu-ai-act --model gpt-4o
 *   evalguard compliance-check --framework hipaa --model claude-3-opus --threshold 80
 *   evalguard compliance-check --framework owasp-llm --json
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
import { resolveApiKey as resolveCliApiKey, resolveBaseUrl as resolveCliBaseUrl } from "../lib/config.js";
import { failSpinner } from "../lib/poll.js";
import { makeCallLLM, detectProviderFromModel } from "../lib/call-llm.js";
import { isErroredFinding } from "@evalguard/core";
import { boundedFetch, decodeJsonBody } from "../lib/http.js";

/** All attack-type names the scanner knows, for the classic-framework path. */
function ATTACK_TYPE_NAMES(core: Record<string, any>): string[] {
  return (core.ATTACK_TYPES ?? []).map((a: { type: string }) => a.type);
}

/**
 * A scan whose attacks all failed to execute carries NO evidence — the target
 * model was never successfully contacted.
 *
 * `runSecurityScan` records an unreachable target as a finding with
 * `output: "[ERROR] …"`, `errored: true`, `passed: false`. Both compliance
 * mappers key requirement status off `passed`, so handing them such a scan
 * reports confident, fabricated NON-COMPLIANCE (measured: EU AI Act
 * overallScore 0, 14 requirements not-met, "All N test(s) failed. Immediate
 * remediation required.") for a model that was never asked a single question.
 *
 * Returning null routes the caller to the honest dry-run report, where every
 * requirement is "untested".
 *
 * NOTE (audit A137): this is a CALLER-SIDE convenience, not the fix. It only
 * covers the ALL-errored case and only in this CLI; the four web routes that
 * call `GapAnalysis.analyze` had no equivalent, and a PARTIALLY errored scan
 * still fabricated failures everywhere. `GapAnalysis.analyze` now excludes
 * errored findings itself. This is kept because "the model was never reached at
 * all" deserves the explicit dry-run report rather than an all-untested one.
 * The predicate is the shared `isErroredFinding` — do not re-inline it.
 */
export function discardIfAllErrored(scanResults: any): any {
  const findings = scanResults?.findings;
  if (!Array.isArray(findings) || findings.length === 0) return scanResults;
  const errored = findings.filter((f: any) => isErroredFinding(f));
  return errored.length === findings.length ? null : scanResults;
}

const SUPPORTED_FRAMEWORKS = [
  "eu-ai-act",
  "hipaa",
  "fedramp",
  "pci-dss",
  "iso-42001",
  "owasp-llm",
  "nist-ai-rmf",
] as const;

type FrameworkId = (typeof SUPPORTED_FRAMEWORKS)[number];

interface ComplianceCheckConfig {
  framework: FrameworkId;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  threshold: number;
  /** Org UUID — REQUIRED for the remote (API-key) path; the route's Zod
   *  schema rejects requests without it. From --org or EVALGUARD_ORG_ID. */
  orgId?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


interface RequirementResult {
  id: string;
  title: string;
  category: string;
  severity: string;
  status: "met" | "partial" | "not-met" | "untested";
  notes: string;
}

interface ComplianceResult {
  framework: string;
  frameworkName: string;
  version: string;
  model: string;
  timestamp: string;
  overallScore: number;
  totalRequirements: number;
  metCount: number;
  partialCount: number;
  notMetCount: number;
  untestedCount: number;
  requirements: RequirementResult[];
  byCategory: Record<
    string,
    {
      name: string;
      total: number;
      met: number;
      partial: number;
      notMet: number;
      untested: number;
      score: number;
    }
  >;
  remediationSteps: {
    priority: number;
    requirementId: string;
    requirementTitle: string;
    severity: string;
    action: string;
    effort: string;
    automatable: boolean;
  }[];
}

function getApiKey(): string | undefined {
  return resolveCliApiKey();
}

function getBaseUrl(): string {
  return resolveCliBaseUrl();
}

/**
 * Build the remote compliance-check endpoint. `baseUrl` already includes the
 * `/api/v1` prefix (from env/config/default), so we append only the route path.
 * Exported for a regression test guarding against the double `/api/v1/api/v1`
 * URL (audit: cli-compliance-double-apiv1-prefix).
 */
export function complianceCheckUrl(baseUrl: string): string {
  return `${baseUrl}/compliance/check`;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/**
 * Environment variable holding the LLM provider credential for `provider`.
 * Shared by the local and remote paths so they resolve the same key.
 */
export function providerApiKeyEnvVar(provider: string): string {
  const map: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    mistral: "MISTRAL_API_KEY",
  };
  return map[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

/**
 * Build the POST body for the remote compliance check.
 *
 * The route's PostBody Zod schema
 * (apps/web/src/app/api/v1/compliance/check/route.ts) requires SIX fields:
 * `orgId` (uuid), `framework`, `model`, `provider`, `systemPrompt` and `apiKey`
 * — all `.min(1)`, none optional. The body only ever carried
 * `{orgId, framework, model?, systemPrompt?}`, so Zod rejected every request
 * with 400 VALIDATION_ERROR before the handler ran: `evalguard
 * compliance-check` was DOA for every authenticated (API-key) user. `model` and
 * `systemPrompt` were additionally sent as `undefined`, which `JSON.stringify`
 * DROPS, so even those two were missing whenever the flags were omitted.
 *
 * `apiKey` here is the LLM PROVIDER credential the server needs to run the
 * scan — distinct from the EvalGuard API key in the Authorization header.
 * Resolved from the same env var the local path uses.
 *
 * Throws a clear, actionable error for anything it cannot resolve. Exported for
 * regression testing.
 */
export function complianceCheckPayload(
  config: ComplianceCheckConfig,
  env: NodeJS.ProcessEnv = process.env,
): {
  orgId: string;
  framework: FrameworkId;
  model: string;
  provider: string;
  systemPrompt: string;
  apiKey: string;
} {
  if (!config.orgId) {
    throw new Error(
      "orgId is required for the API compliance check. Pass --org <uuid> or set EVALGUARD_ORG_ID.",
    );
  }
  const model = config.model ?? DEFAULT_MODEL;
  const provider = config.provider ?? detectProvider(model);
  const envVar = providerApiKeyEnvVar(provider);
  const apiKey = env[envVar];
  if (!apiKey) {
    throw new Error(
      `The API compliance check runs the scan against ${provider}, so it needs that ` +
        `provider's key. Set ${envVar}, or pass --provider <provider> to use a different one.`,
    );
  }
  return {
    orgId: config.orgId,
    framework: config.framework,
    model,
    provider,
    systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    apiKey,
  };
}

/** The engine result the route returns, as far as the CLI reads it. */
interface RemoteCheckResult {
  framework?: string;
  frameworkName?: string;
  version?: string;
  overallScore?: number;
  totalRequirements?: number;
  timestamp?: string;
  requirementResults?: {
    requirementId: string;
    category: string;
    title: string;
    status: string;
    score?: number;
    findings?: string[];
    remediation?: string;
  }[];
  remediationPlan?: {
    requirementId: string;
    priority: string;
    action: string;
    effort: string;
  }[];
}

/**
 * Map the route's engine result onto the shape the CLI's renderer expects.
 *
 * The route responds `{ success, data: ComplianceCheckResult }` — the CLI cast
 * the whole envelope straight to its own `ComplianceResult`, so every field the
 * report prints (overallScore, metCount, byCategory, …) came out `undefined`
 * and the threshold comparison was `undefined >= 70` → always "FAILED", exit 1.
 * The engine also names things differently (`requirementResults` vs
 * `requirements`, `remediationPlan` vs `remediationSteps`) and reports no
 * per-status counts, so they are derived here. Exported for regression testing.
 */
export function normalizeRemoteResult(
  data: RemoteCheckResult,
  model: string,
): ComplianceResult {
  const results = data.requirementResults ?? [];
  const severityFor = (requirementId: string): string =>
    data.remediationPlan?.find((s) => s.requirementId === requirementId)?.priority ?? "medium";

  const requirements: RequirementResult[] = results.map((r) => ({
    id: r.requirementId,
    title: r.title,
    category: r.category,
    severity: severityFor(r.requirementId),
    status:
      r.status === "met" || r.status === "partial" || r.status === "not-met"
        ? r.status
        : "untested",
    notes: r.findings?.length ? r.findings.join("; ") : (r.remediation ?? ""),
  }));

  const byCategory: ComplianceResult["byCategory"] = {};
  for (const r of requirements) {
    const cat = (byCategory[r.category] ??= {
      name: r.category,
      total: 0,
      met: 0,
      partial: 0,
      notMet: 0,
      untested: 0,
      score: 0,
    });
    cat.total++;
    if (r.status === "met") cat.met++;
    else if (r.status === "partial") cat.partial++;
    else if (r.status === "not-met") cat.notMet++;
    else cat.untested++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.score = cat.total > 0 ? Math.round((cat.met / cat.total) * 100) : 0;
  }

  return {
    framework: data.framework ?? "",
    frameworkName: data.frameworkName ?? data.framework ?? "",
    version: data.version ?? "unknown",
    model,
    timestamp: data.timestamp ?? new Date().toISOString(),
    overallScore: data.overallScore ?? 0,
    totalRequirements: data.totalRequirements ?? requirements.length,
    metCount: requirements.filter((r) => r.status === "met").length,
    partialCount: requirements.filter((r) => r.status === "partial").length,
    notMetCount: requirements.filter((r) => r.status === "not-met").length,
    untestedCount: requirements.filter((r) => r.status === "untested").length,
    requirements,
    byCategory,
    remediationSteps: (data.remediationPlan ?? []).map((s, i) => ({
      priority: i + 1,
      requirementId: s.requirementId,
      requirementTitle:
        results.find((r) => r.requirementId === s.requirementId)?.title ?? s.requirementId,
      severity: s.priority,
      action: s.action,
      effort: s.effort,
      automatable: false,
    })),
  };
}

/**
 * Run compliance check via the EvalGuard API.
 */
async function runRemoteCheck(
  config: ComplianceCheckConfig,
): Promise<ComplianceResult> {
  const apiKey = getApiKey()!;
  const baseUrl = getBaseUrl();

  // baseUrl already carries the /api/v1 prefix (env/config/default) — appending
  // another /api/v1 produced /api/v1/api/v1/compliance/check → 404 for every
  // authenticated user (audit: cli-compliance-double-apiv1-prefix).
  const res = await boundedFetch(complianceCheckUrl(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(complianceCheckPayload(config)),
  });

  if (!res.ok) {
    const errBody = (await decodeJsonBody(res, "compliance-check")) as
      | { error?: { message?: string; code?: string }; message?: string }
      | null;
    // apiError responds `{success:false, error:{message, code}}`; reading a
    // top-level `message` reported every failure as "Unknown error".
    const message = errBody?.error?.message ?? errBody?.message ?? res.statusText;
    throw new Error(`API error ${res.status}: ${message || "Unknown error"}`);
  }

  // apiSuccess wraps the payload: `{success:true, data:{...}}`.
  const json = (await res.json()) as { data?: unknown } | null;
  const payload = (json && typeof json === "object" && "data" in json ? json.data : json) ?? {};
  return normalizeRemoteResult(payload as RemoteCheckResult, config.model ?? DEFAULT_MODEL);
}

/**
 * Resolve the framework ID from the CLI flag to the core framework constant.
 * The core library uses different export names and sometimes different IDs.
 */
function resolveFramework(
  frameworkId: FrameworkId,
  core: Record<string, unknown>,
): unknown {
  const map: Record<FrameworkId, { export: string; fallback?: string }> = {
    "eu-ai-act": { export: "EU_AI_ACT" },
    hipaa: { export: "HIPAA_AI", fallback: "HIPAA" },
    fedramp: { export: "FEDRAMP_AI" },
    "pci-dss": { export: "PCI_DSS_AI" },
    "iso-42001": { export: "ISO_42001" },
    "owasp-llm": { export: "OWASP_LLM_TOP10" },
    "nist-ai-rmf": { export: "NIST_AI_RMF" },
  };

  const entry = map[frameworkId];
  const fw = core[entry.export] ?? (entry.fallback ? core[entry.fallback] : undefined);
  if (!fw) {
    throw new Error(
      `Framework "${frameworkId}" is not available in the installed @evalguard/core version.`,
    );
  }
  return fw;
}

/**
 * Detect the provider from the model name.
 *
 * 2026-07-29 (audit A1): this was a local copy that returned "google" for
 * gemini-* and "meta" for llama-*. `createProvider` registers NEITHER, so it
 * threw `Unknown provider "google"` and this command silently degraded to the
 * dry-run report for every Gemini or Llama model. Now delegates to the single
 * canonical mapper in lib/call-llm.ts.
 */
const detectProvider = detectProviderFromModel;

/**
 * Run compliance check locally using @evalguard/core.
 */
async function runLocalCheck(
  config: ComplianceCheckConfig,
): Promise<ComplianceResult> {
  const core = (await import("@evalguard/core")) as Record<string, any>;
  const { GapAnalysis, runSecurityScan, createProvider } = core;

  const framework = resolveFramework(config.framework, core) as {
    id: string;
    name: string;
    version: string;
    categories: { id: string; name: string; description: string }[];
    requirements?: unknown[];
  };

  const model = config.model ?? DEFAULT_MODEL;
  const providerName = config.provider ?? detectProvider(model);

  // Resolve API key for the LLM provider (same env var the remote path sends).
  const llmApiKey = process.env[providerApiKeyEnvVar(providerName)];

  // Determine if this is an "enhanced" framework (has requirements) or a
  // "classic" framework (has categories.controls). They use different analysis paths.
  const isEnhanced = !!(framework as any).requirements;

  if (isEnhanced) {
    // Enhanced frameworks: EU AI Act, HIPAA, FedRAMP, PCI-DSS, ISO 42001
    // Use GapAnalysis which works against ComplianceFrameworkEnhanced.
    const gapAnalysis = new GapAnalysis();

    // Collect all automatable attack types from the framework requirements
    const requirements = (framework as any).requirements as Array<{
      id: string;
      title: string;
      description: string;
      category: string;
      severity: string;
      automatable: boolean;
      attackTypes?: string[];
      pluginIds?: string[];
    }>;

    const attackTypes = new Set<string>();
    for (const req of requirements) {
      if (req.automatable && req.attackTypes) {
        for (const at of req.attackTypes) {
          attackTypes.add(at);
        }
      }
    }

    // Build minimal scan results if no LLM key is available (dry-run mode)
    let scanResults: any;

    if (llmApiKey && typeof runSecurityScan === "function") {
      try {
        // `runSecurityScan` drives the target model through `config.callLLM`
        // (scanner.ts:28 destructures `{ prompt, attackTypes, callLLM }`). It
        // does NOT accept `{ model, provider, apiKey }` and build a client
        // itself.
        //
        // BUG FIXED 2026-07-29 (F31): this call passed model/provider/apiKey and
        // NO callLLM, so every attack threw "callLLM is not a function", the
        // scanner caught it into `[ERROR] …` findings, and the outer `catch`
        // never fired because runSecurityScan RESOLVED. Reproduced against
        // dist: 40 findings, all `output: "[ERROR] callLLM is not a function"`,
        // errored:true / passed:false, which GapAnalysis then scored as real EU
        // AI Act compliance FAILURES — overallScore 0 with 14 requirements
        // marked not-met and notes reading "All N test(s) failed. Immediate
        // remediation required." A user was shown fabricated non-compliance for
        // a model that was never contacted.
        const callLLM = await makeCallLLM(providerName, model, createProvider, llmApiKey);

        scanResults = await runSecurityScan({
          systemPrompt: config.systemPrompt ?? "You are a helpful assistant.",
          attackTypes: [...attackTypes],
          callLLM,
        });

        // A scan whose attacks could not execute is NOT evidence of
        // non-compliance. Treat it as no evidence at all (dry-run → untested)
        // rather than letting GapAnalysis read `passed: false` as "failed".
        scanResults = discardIfAllErrored(scanResults);
      } catch {
        // Fall through to dry-run mode
        scanResults = null;
      }
    }

    if (!scanResults) {
      // Dry-run: generate a gap report with all requirements as "untested"
      scanResults = { findings: [], passed: false, score: 0 };
    }

    const report = gapAnalysis.analyze(scanResults, framework);
    const remediationSteps = gapAnalysis.getRemediationPlan(report.gaps);

    // Build result
    const byCategory: ComplianceResult["byCategory"] = {};
    for (const cat of framework.categories) {
      const catData = report.byCategory[cat.id];
      if (catData) {
        byCategory[cat.id] = {
          name: cat.name,
          total: catData.total,
          met: catData.met,
          partial: catData.partial,
          notMet: catData.notMet,
          untested: catData.untested,
          score: catData.score,
        };
      }
    }

    return {
      framework: framework.id,
      frameworkName: framework.name,
      version: framework.version,
      model,
      timestamp: new Date().toISOString(),
      overallScore: report.overallScore,
      totalRequirements: report.totalRequirements,
      metCount: report.metCount,
      partialCount: report.partialCount,
      notMetCount: report.notMetCount,
      untestedCount: report.untestedCount,
      requirements: report.gaps.map((g: any) => ({
        id: g.requirement.id,
        title: g.requirement.title,
        category: g.requirement.category,
        severity: g.requirement.severity,
        status: g.status,
        notes: g.notes,
      })),
      byCategory,
      remediationSteps: remediationSteps.map((s: any, i: number) => ({
        priority: i + 1,
        requirementId: s.requirementId,
        requirementTitle: s.requirementTitle,
        severity: s.severity,
        action: s.action,
        effort: s.effort,
        automatable: s.automatable,
      })),
    };
  } else {
    // Classic frameworks: OWASP LLM Top 10, NIST AI RMF, MITRE ATLAS
    // Use mapToCompliance which works against ComplianceFramework.
    const { mapToCompliance } = core;

    let scanResults: any;

    if (llmApiKey && typeof runSecurityScan === "function") {
      try {
        // Same defect as the enhanced branch above (F31): no `callLLM` was
        // wired. Here it additionally omitted `attackTypes`, so
        // `attackTypes.includes` threw and the dry-run fallback engaged — which
        // meant `compliance-check` against OWASP LLM Top 10 / NIST AI RMF /
        // MITRE ATLAS NEVER actually tested the model, it only ever emitted an
        // all-untested report. Both are fixed the same way.
        const callLLM = await makeCallLLM(providerName, model, createProvider, llmApiKey);

        scanResults = await runSecurityScan({
          systemPrompt: config.systemPrompt ?? "You are a helpful assistant.",
          attackTypes: ATTACK_TYPE_NAMES(core),
          callLLM,
        });

        scanResults = discardIfAllErrored(scanResults);
      } catch {
        scanResults = null;
      }
    }

    if (!scanResults) {
      scanResults = { findings: [], passed: false, score: 0 };
    }

    const report = mapToCompliance(scanResults, framework.id);

    const totalControls = report.findings.length;
    const passCount = report.findings.filter((f: any) => f.status === "pass").length;
    const failCount = report.findings.filter((f: any) => f.status === "fail").length;
    const untestedCount = report.findings.filter((f: any) => f.status === "untested").length;
    const overallScore = totalControls > 0 ? Math.round((passCount / totalControls) * 100) : 0;

    const byCategory: ComplianceResult["byCategory"] = {};
    for (const cat of framework.categories) {
      const catFindings = report.findings.filter(
        (f: any) => f.control?.categoryId === cat.id || f.categoryId === cat.id,
      );
      const met = catFindings.filter((f: any) => f.status === "pass").length;
      const notMet = catFindings.filter((f: any) => f.status === "fail").length;
      const untested = catFindings.filter((f: any) => f.status === "untested").length;
      const total = catFindings.length;
      byCategory[cat.id] = {
        name: cat.name,
        total,
        met,
        partial: 0,
        notMet,
        untested,
        score: total > 0 ? Math.round((met / total) * 100) : 0,
      };
    }

    return {
      framework: framework.id,
      frameworkName: framework.name,
      version: framework.version,
      model,
      timestamp: new Date().toISOString(),
      overallScore,
      totalRequirements: totalControls,
      metCount: passCount,
      partialCount: 0,
      notMetCount: failCount,
      untestedCount,
      requirements: report.findings.map((f: any) => ({
        id: f.controlId ?? f.control?.id ?? f.id,
        title: f.controlName ?? f.control?.name ?? f.title ?? f.id,
        category: f.control?.categoryId ?? f.categoryId ?? "unknown",
        severity: f.control?.severity ?? f.severity ?? "medium",
        status: f.status === "pass" ? "met" : f.status === "fail" ? "not-met" : "untested",
        notes:
          f.status === "pass"
            ? "All tests passed."
            : f.status === "fail"
              ? "Test failures detected. Remediation required."
              : "No test coverage for this control.",
      })),
      byCategory,
      remediationSteps: report.findings
        .filter((f: any) => f.status === "fail")
        .map((f: any, i: number) => ({
          priority: i + 1,
          requirementId: f.control?.id ?? f.id,
          requirementTitle: f.control?.name ?? f.title ?? f.id,
          severity: f.control?.severity ?? "medium",
          action: `Implement controls for: ${f.control?.name ?? f.title}. ${f.control?.description ?? ""}`.trim(),
          effort: "medium" as const,
          automatable: true,
        })),
    };
  }
}

// ─── Output Formatting ──────────────────────────────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case "met":
      return chalk.green("PASS");
    case "partial":
      return chalk.yellow("PARTIAL");
    case "not-met":
      return chalk.red("FAIL");
    case "untested":
      return chalk.dim("UNTESTED");
    default:
      return chalk.dim(status);
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return chalk.red.bold(severity.toUpperCase());
    case "high":
      return chalk.red(severity.toUpperCase());
    case "medium":
      return chalk.yellow(severity.toUpperCase());
    case "low":
      return chalk.dim(severity.toUpperCase());
    default:
      return severity;
  }
}

function printReport(result: ComplianceResult): void {
  const { overallScore, threshold } = result as ComplianceResult & { threshold?: number };

  console.log("");
  console.log(chalk.bold.underline(`Compliance Report: ${result.frameworkName} (v${result.version})`));
  console.log(chalk.dim(`Model: ${result.model}  |  Timestamp: ${result.timestamp}`));
  console.log("");

  // Overall score bar
  const scoreColor = overallScore >= 80 ? chalk.green : overallScore >= 50 ? chalk.yellow : chalk.red;
  const barLen = 30;
  const filled = Math.round((overallScore / 100) * barLen);
  const bar = scoreColor("\u2588".repeat(filled)) + chalk.dim("\u2591".repeat(barLen - filled));
  console.log(`  Overall Score: ${bar} ${scoreColor.bold(`${overallScore}%`)}`);
  console.log("");

  // Summary counts
  console.log(
    `  ${chalk.green(String(result.metCount))} met  |  ` +
      `${chalk.yellow(String(result.partialCount))} partial  |  ` +
      `${chalk.red(String(result.notMetCount))} not met  |  ` +
      `${chalk.dim(String(result.untestedCount))} untested  |  ` +
      `${chalk.bold(String(result.totalRequirements))} total`,
  );
  console.log("");

  // Category breakdown
  console.log(chalk.bold("  Category Breakdown:"));
  for (const [catId, cat] of Object.entries(result.byCategory)) {
    const catScore = cat.score;
    const catColor = catScore >= 80 ? chalk.green : catScore >= 50 ? chalk.yellow : chalk.red;
    console.log(
      `    ${chalk.bold(cat.name)} ${chalk.dim(`(${catId})`)} — ${catColor.bold(`${catScore}%`)} ` +
        chalk.dim(`[${cat.met} met, ${cat.partial} partial, ${cat.notMet} fail, ${cat.untested} untested]`),
    );
  }
  console.log("");

  // Requirements detail (show failures and partials first, then untested, then met)
  const sortedReqs = [...result.requirements].sort((a, b) => {
    const order: Record<string, number> = { "not-met": 0, partial: 1, untested: 2, met: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });

  const failures = sortedReqs.filter((r) => r.status === "not-met" || r.status === "partial");
  if (failures.length > 0) {
    console.log(chalk.bold("  Findings Requiring Attention:"));
    for (const req of failures) {
      console.log(
        `    ${statusIcon(req.status)}  ${chalk.bold(req.id)} ${req.title} ` +
          chalk.dim(`[${severityColor(req.severity)}]`),
      );
      if (req.notes) {
        console.log(`         ${chalk.dim(req.notes)}`);
      }
    }
    console.log("");
  }

  // Remediation steps
  if (result.remediationSteps.length > 0) {
    console.log(chalk.bold("  Remediation Plan:"));
    const maxSteps = Math.min(result.remediationSteps.length, 10);
    for (let i = 0; i < maxSteps; i++) {
      const step = result.remediationSteps[i]!;
      const effortBadge =
        step.effort === "high"
          ? chalk.red("[HIGH EFFORT]")
          : step.effort === "medium"
            ? chalk.yellow("[MED EFFORT]")
            : chalk.green("[LOW EFFORT]");
      console.log(
        `    ${chalk.bold(`${step.priority}.`)} ${severityColor(step.severity)} ${step.requirementTitle} ${effortBadge}`,
      );
      console.log(`       ${chalk.dim(step.action)}`);
    }
    if (result.remediationSteps.length > maxSteps) {
      console.log(
        chalk.dim(`    ... and ${result.remediationSteps.length - maxSteps} more. Use --json for full details.`),
      );
    }
    console.log("");
  }
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerComplianceCheck(program: Command): void {
  program
    .command("compliance-check")
    .description("Check AI system compliance against regulatory frameworks")
    .requiredOption(
      "-f, --framework <id>",
      `Framework to check against (${SUPPORTED_FRAMEWORKS.join(", ")})`,
    )
    .option("-m, --model <model>", "Model to evaluate", "gpt-4o-mini")
    .option("-p, --provider <provider>", "LLM provider override")
    .option("--org <orgId>", "Org UUID for the API check (or set EVALGUARD_ORG_ID)")
    .option("-t, --threshold <number>", "Minimum compliance score (0-100) to pass", "70")
    .option("--json", "Output results as JSON", false)
    .option("--system-prompt <prompt>", "System prompt to test against")
    .option("--config <path>", "Path to compliance config file (JSON)")
    .action(
      async (opts: {
        framework: string;
        model: string;
        provider?: string;
        org?: string;
        threshold: string;
        json: boolean;
        systemPrompt?: string;
        config?: string;
      }) => {
        // Validate framework
        const frameworkId = opts.framework.toLowerCase() as FrameworkId;
        if (!SUPPORTED_FRAMEWORKS.includes(frameworkId)) {
          console.error(
            chalk.red(
              `Unknown framework: "${opts.framework}". Supported: ${SUPPORTED_FRAMEWORKS.join(", ")}`,
            ),
          );
          process.exit(1);
        }

        // Parse threshold
        const threshold = parseInt(opts.threshold, 10);
        if (isNaN(threshold) || threshold < 0 || threshold > 100) {
          console.error(
            chalk.red(`Invalid threshold: "${opts.threshold}". Must be 0-100.`),
          );
          process.exit(1);
        }

        // Load config file if provided
        let configOverrides: Partial<ComplianceCheckConfig> = {};
        if (opts.config) {
          const configPath = path.resolve(opts.config);
          if (!fs.existsSync(configPath)) {
            console.error(chalk.red(`Config file not found: ${configPath}`));
            process.exit(1);
          }
          try {
            configOverrides = JSON.parse(
              fs.readFileSync(configPath, "utf-8"),
            ) as Partial<ComplianceCheckConfig>;
          } catch (err) {
            console.error(
              chalk.red(
                `Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            process.exit(1);
          }
        }

        // Resolve org from flag → env → config file. Required for the remote
        // (API-key) path; the route 400s without it. Validate format up front
        // so the user gets a clear message instead of a generic API 400.
        const orgId = opts.org ?? process.env.EVALGUARD_ORG_ID ?? configOverrides.orgId;
        if (orgId && !UUID_RE.test(orgId)) {
          console.error(chalk.red(`Invalid --org: "${orgId}". Must be a UUID.`));
          process.exit(1);
        }

        const checkConfig: ComplianceCheckConfig = {
          framework: frameworkId,
          model: opts.model ?? configOverrides.model,
          provider: opts.provider ?? configOverrides.provider,
          systemPrompt: opts.systemPrompt ?? configOverrides.systemPrompt,
          orgId,
          threshold,
        };

        const spinner = opts.json ? null : ora(`Running ${frameworkId} compliance check...`).start();

        try {
          let result: ComplianceResult;
          const apiKey = getApiKey();

          if (apiKey) {
            if (spinner) spinner.text = `Running ${frameworkId} compliance check via API...`;
            result = await runRemoteCheck(checkConfig);
          } else {
            if (spinner) spinner.text = `Running ${frameworkId} compliance check locally...`;
            result = await runLocalCheck(checkConfig);
          }

          spinner?.stop();

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  ...result,
                  threshold,
                  passed: result.overallScore >= threshold,
                },
                null,
                2,
              ),
            );
          } else {
            printReport(result);

            // Final verdict
            if (result.overallScore >= threshold) {
              console.log(
                chalk.green.bold(
                  `  PASSED  Compliance score ${result.overallScore}% meets threshold ${threshold}%`,
                ),
              );
            } else {
              console.log(
                chalk.red.bold(
                  `  FAILED  Compliance score ${result.overallScore}% is below threshold ${threshold}%`,
                ),
              );
            }
            console.log("");
          }

          // Exit code based on threshold. Set process.exitCode + return rather
          // than process.exit(): calling process.exit() while ora's spinner
          // stream/interval is still tearing down aborts libuv with exit 127 on
          // Windows (breaks CI exit codes). Same reason failSpinner() exists.
          process.exitCode = result.overallScore >= threshold ? 0 : 1;
          return;
        } catch (err) {
          const msg = `Compliance check failed: ${err instanceof Error ? err.message : String(err)}`;
          if (spinner) {
            failSpinner(spinner, msg);
          } else {
            console.error(msg);
            process.exitCode = 1;
          }
          return;
        }
      },
    );
}
