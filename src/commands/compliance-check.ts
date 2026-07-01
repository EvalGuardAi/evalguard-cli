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

/**
 * Build the POST body for the remote compliance check. The route's PostBody
 * Zod schema requires `orgId: z.string().uuid()`, so a body without it 400s
 * BEFORE the handler runs — which made `evalguard compliance-check` DOA for
 * every authenticated (API-key) user (audit 2026-06-16, HIGH; the prior test
 * only covered the URL, not the body). Throws a clear, actionable error when
 * orgId is absent. Exported for regression testing.
 */
export function complianceCheckPayload(config: ComplianceCheckConfig): {
  orgId: string;
  framework: FrameworkId;
  model?: string;
  systemPrompt?: string;
} {
  if (!config.orgId) {
    throw new Error(
      "orgId is required for the API compliance check. Pass --org <uuid> or set EVALGUARD_ORG_ID.",
    );
  }
  return {
    orgId: config.orgId,
    framework: config.framework,
    model: config.model,
    systemPrompt: config.systemPrompt,
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
  const res = await fetch(complianceCheckUrl(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(complianceCheckPayload(config)),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      `API error ${res.status}: ${(errBody as Record<string, string>).message ?? "Unknown error"}`,
    );
  }

  return (await res.json()) as ComplianceResult;
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
 */
function detectProvider(model: string): string {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("llama") || model.startsWith("meta-")) return "meta";
  if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
  return "openai";
}

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

  const model = config.model ?? "gpt-4o-mini";
  const providerName = config.provider ?? detectProvider(model);

  // Resolve API key for the LLM provider
  const apiKeyEnvMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    mistral: "MISTRAL_API_KEY",
  };
  const envVar = apiKeyEnvMap[providerName] ?? `${providerName.toUpperCase()}_API_KEY`;
  const llmApiKey = process.env[envVar];

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
        const provider = typeof createProvider === "function"
          ? createProvider(providerName, { apiKey: llmApiKey, model })
          : undefined;

        scanResults = await runSecurityScan({
          model,
          provider: provider ?? providerName,
          systemPrompt: config.systemPrompt ?? "You are a helpful assistant.",
          attackTypes: [...attackTypes],
          apiKey: llmApiKey,
        });
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
        const provider = typeof createProvider === "function"
          ? createProvider(providerName, { apiKey: llmApiKey, model })
          : undefined;

        scanResults = await runSecurityScan({
          model,
          provider: provider ?? providerName,
          systemPrompt: config.systemPrompt ?? "You are a helpful assistant.",
          apiKey: llmApiKey,
        });
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

          // Exit code based on threshold
          process.exit(result.overallScore >= threshold ? 0 : 1);
        } catch (err) {
          spinner?.fail(
            `Compliance check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      },
    );
}
