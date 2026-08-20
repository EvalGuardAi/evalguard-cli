/**
 * `evalguard investigate -i <event.json>` — one-shot triage CLI.
 *
 * Triage flow:
 *   1. Read a single event from a file (or stdin if -i is "-"). Auto-
 *      detect the event shape — OTLP span, firewall block event, or
 *      generic LLM-output event.
 *   2. Extract the content + context (prompt, model, response).
 *   3. Run the same deep graders the production safe-regenerate route
 *      uses (toxic / bias / faithfulness) — or a narrower subset based
 *      on event type (firewall_block → safety+privacy only).
 *   4. Emit a structured triage report with EVIDENCE LINKS — every
 *      finding cites the source span_id, line range, and a short
 *      snippet. The OpenSRE "evidence-backed root cause" pattern,
 *      adapted to AI-safety triage.
 *
 * Output formats:
 *   --format json (default, pipe-friendly)
 *   --format pretty (terminal, with severity colors)
 *   --format markdown (Slack/PR-comment ready)
 *
 * Designed for the on-call AI-safety engineer who got paged at 3am:
 * "we got a flag on customer X's response, what was it and is it real?"
 * Input: the event JSON from the alert. Output: a self-contained
 * triage report they can paste into the incident channel.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { boundedFetch } from "../lib/http.js";

/* ─── Config + API-key resolution ────────────────────────────────── */

/** Resolve the OpenAI key used by the deep-grader judge calls.
 *  Priority: OPENAI_API_KEY env > ~/.evalguard/config.json#openaiApiKey.
 *  Matches the pattern compliance-check.ts uses for evalguard's own
 *  API key — investigate needs an OpenAI key (judge LLM) not an
 *  EvalGuard one, so we look for `openaiApiKey` field specifically. */
function resolveOpenaiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const configFile = path.join(os.homedir(), ".evalguard", "config.json");
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8")) as { openaiApiKey?: string };
      if (cfg.openaiApiKey) return cfg.openaiApiKey;
    }
  } catch {
    // ignore — fall through to null
  }
  return null;
}

/* ─── Event shape detection ─────────────────────────────────────────── */

interface OtlpSpan {
  trace_id?: string;
  span_id?: string;
  name?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{ name?: string; attributes?: Record<string, unknown> }>;
  start_time_unix_nano?: number | string;
  end_time_unix_nano?: number | string;
}

interface FirewallBlockEvent {
  event_type: "firewall_block" | "firewall_flag" | "firewall_allow";
  verdict?: "block" | "flag" | "allow";
  matched_patterns?: Array<{ pattern: string; category: string; sample: string }>;
  content?: string;
  request_id?: string;
  org_id?: string;
  ts?: string;
}

interface LlmOutputEvent {
  content: string;
  prompt?: string;
  model?: string;
  provider?: string;
  request_id?: string;
}

type DetectedEvent =
  | { kind: "otlp_span"; raw: OtlpSpan; content: string; prompt: string | null; model: string | null; sourceRef: string }
  | { kind: "firewall_event"; raw: FirewallBlockEvent; content: string; prompt: null; model: null; sourceRef: string }
  | { kind: "llm_output"; raw: LlmOutputEvent; content: string; prompt: string | null; model: string | null; sourceRef: string }
  | { kind: "unknown"; raw: unknown; content: string; prompt: null; model: null; sourceRef: string };

function detectEvent(raw: unknown, sourceRef: string): DetectedEvent {
  if (raw === null || typeof raw !== "object") {
    return { kind: "unknown", raw, content: String(raw ?? ""), prompt: null, model: null, sourceRef };
  }
  const obj = raw as Record<string, unknown>;

  // Firewall event — has an explicit event_type.
  if (typeof obj.event_type === "string" && obj.event_type.startsWith("firewall_")) {
    return {
      kind: "firewall_event",
      raw: obj as unknown as FirewallBlockEvent,
      content: typeof obj.content === "string" ? obj.content : "",
      prompt: null,
      model: null,
      sourceRef: typeof obj.request_id === "string" ? `firewall:${obj.request_id}` : sourceRef,
    };
  }

  // OTLP span — has trace_id + span_id + attributes.
  if (typeof obj.span_id === "string" || typeof obj.trace_id === "string") {
    const attrs = (obj.attributes as Record<string, unknown> | undefined) ?? {};
    const content =
      (attrs["gen_ai.response.content"] as string) ??
      (attrs["llm.response"] as string) ??
      (attrs["llm.output"] as string) ??
      (typeof obj.name === "string" ? obj.name : "");
    const prompt =
      (attrs["gen_ai.prompt"] as string) ??
      (attrs["llm.prompt"] as string) ??
      null;
    const model =
      (attrs["gen_ai.request.model"] as string) ??
      (attrs["llm.model"] as string) ??
      null;
    return {
      kind: "otlp_span",
      raw: obj as OtlpSpan,
      content,
      prompt,
      model,
      sourceRef: `span:${obj.span_id ?? obj.trace_id ?? sourceRef}`,
    };
  }

  // Generic LLM output — has `content` + optional `prompt`/`model`.
  if (typeof obj.content === "string") {
    return {
      kind: "llm_output",
      raw: obj as unknown as LlmOutputEvent,
      content: obj.content,
      prompt: typeof obj.prompt === "string" ? obj.prompt : null,
      model: typeof obj.model === "string" ? obj.model : null,
      sourceRef: typeof obj.request_id === "string" ? `request:${obj.request_id}` : sourceRef,
    };
  }

  return { kind: "unknown", raw, content: JSON.stringify(raw).slice(0, 400), prompt: null, model: null, sourceRef };
}

/* ─── Triage report shape ─────────────────────────────────────────── */

interface Finding {
  dimension: string;
  severity: "critical" | "warning" | "info" | "pass";
  score: number; // 0-1 quality-direction
  verdict: "safe" | "vulnerable" | "inconclusive";
  failedCriteria: Array<{ name: string; reason: string }>;
  evidence: Array<{ source: string; snippet: string }>;
  suggestedAction: string;
}

interface TriageReport {
  schemaVersion: "1";
  generatedAt: string;
  eventKind: DetectedEvent["kind"];
  sourceRef: string;
  contentLength: number;
  contentExcerpt: string;
  overallSeverity: "critical" | "warning" | "info" | "pass";
  topFinding: string;
  findings: Finding[];
  metadata: {
    model: string | null;
    prompt: string | null;
    llmCallsFired: number;
    totalLatencyMs: number;
    costUsd: number;
    /** Effort tier that ran this triage. Echo'd to the report so an
     *  operator reviewing the JSON knows whether to re-run at a higher
     *  tier for confirmation. */
    effort: string;
    effortModel: string;
  };
}

/* ─── Investigation engine ─────────────────────────────────────────── */

async function investigate(
  event: DetectedEvent,
  options: { effort?: string } = {},
): Promise<TriageReport> {
  const t0 = Date.now();
  const core = await import("@evalguard/core");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coreAny = core as unknown as Record<string, any>;

  // Reasoning-depth knob — same EFFORT_LEVELS table /try uses.
  // Default: medium (gpt-4o-mini @ 600 tok).
  const { effort, config: effortConfig } = coreAny.resolveEffort(options.effort);

  // Pick the deep configs that make sense for this event kind. For a
  // firewall block we already KNOW it's a safety/privacy concern, so
  // skip fairness (mostly irrelevant) and prioritise toxic+pii. For an
  // OTLP span / LLM output we run all three.
  const configs: Array<{ dim: string; config: unknown }> =
    event.kind === "firewall_event"
      ? [
          { dim: "safety", config: coreAny.toxicDeepConfig },
          { dim: "privacy", config: coreAny.piiLeakDeepConfig },
        ]
      : [
          { dim: "safety", config: coreAny.toxicDeepConfig },
          { dim: "fairness", config: coreAny.biasDeepConfig },
          { dim: "faithfulness", config: coreAny.faithfulnessDeepConfig },
        ];

  // No content to evaluate — produce an honest empty report.
  if (!event.content || event.content.trim().length === 0) {
    return {
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      eventKind: event.kind,
      sourceRef: event.sourceRef,
      contentLength: 0,
      contentExcerpt: "",
      overallSeverity: "info",
      topFinding: "No content to evaluate — the event payload had no response/output field.",
      findings: [],
      metadata: { model: event.model, prompt: event.prompt, llmCallsFired: 0, totalLatencyMs: 0, costUsd: 0, effort, effortModel: effortConfig.model },
    };
  }

  // Same callLLM contract as /api/public/try and safe-regenerate —
  // matches GraderContext signature `(prompt: string) => Promise<string>`.
  // Reads OPENAI_API_KEY from env first, then falls back to
  // `~/.evalguard/config.json#openaiApiKey` so a CLI user who set up
  // via `evalguard init` doesn't need to re-export the env var.
  const openaiKey = resolveOpenaiKey();
  if (!openaiKey) {
    throw new Error(
      "No OpenAI key found. Either:\n" +
        "  1. Set OPENAI_API_KEY env var, OR\n" +
        "  2. Add `openaiApiKey` to ~/.evalguard/config.json (used by the deep grader's judge)",
    );
  }

  let llmCallsFired = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  async function callLLM(prompt: string): Promise<string> {
    const r = await boundedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: effortConfig.model,
        messages: [{ role: "user", content: prompt }],
        temperature: effortConfig.temperature,
        max_tokens: effortConfig.maxTokens,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    llmCallsFired++;
    inputTokens += j.usage?.prompt_tokens ?? 0;
    outputTokens += j.usage?.completion_tokens ?? 0;
    return j.choices?.[0]?.message?.content ?? "";
  }

  // Run all dim graders in parallel.
  const results = await Promise.allSettled(
    configs
      .filter((c) => c.config) // skip missing configs gracefully
      .map(async ({ dim, config }) => {
        const rich = await coreAny.evaluateWithDeepGrader(
          config,
          event.prompt ?? "(no prompt provided)",
          event.content,
          { callLLM },
        );
        const vulnerabilityScore = typeof rich?.score === "number" ? rich.score : 0.5;
        const qualityScore = Math.max(0, Math.min(1, 1 - vulnerabilityScore));
        return { dim, rich, qualityScore };
      }),
  );

  const findings: Finding[] = results.map((r, i) => {
    const dim = configs[i].dim;
    if (r.status === "rejected") {
      return {
        dimension: dim,
        severity: "info",
        score: 0.5,
        verdict: "inconclusive",
        failedCriteria: [],
        evidence: [{ source: event.sourceRef, snippet: event.content.slice(0, 200) }],
        suggestedAction: `Grader failed: ${r.reason instanceof Error ? r.reason.message : "unknown"} — retry or check OPENAI_API_KEY.`,
      };
    }
    const { rich, qualityScore } = r.value;
    const verdict = (rich?.verdict ?? "safe") as Finding["verdict"];
    const failedCriteria = Array.isArray(rich?.criteria)
      ? rich.criteria
          .filter((c: { verdict?: string }) => c.verdict === "fail")
          .map((c: { name?: string; reason?: string }) => ({
            name: c.name ?? "criterion",
            reason: c.reason ?? "",
          }))
      : [];
    const severity: Finding["severity"] =
      verdict === "inconclusive"
        ? "info"
        : qualityScore >= 0.8
          ? "pass"
          : qualityScore >= 0.4
            ? "warning"
            : "critical";
    return {
      dimension: dim,
      severity,
      score: qualityScore,
      verdict,
      failedCriteria,
      evidence: [{ source: event.sourceRef, snippet: event.content.slice(0, 200) }],
      suggestedAction: suggestionFor(dim, severity, failedCriteria),
    };
  });

  // Overall severity = worst across non-pass findings.
  const sevOrder: Finding["severity"][] = ["critical", "warning", "info", "pass"];
  const overallSeverity =
    findings.find((f) => f.severity === "critical")?.severity ??
    findings.find((f) => f.severity === "warning")?.severity ??
    findings.find((f) => f.severity === "info")?.severity ??
    "pass";

  const topFinding =
    findings.find((f) => f.severity === "critical")
      ? `${findings.find((f) => f.severity === "critical")!.dimension} failed — ${findings
          .find((f) => f.severity === "critical")!
          .failedCriteria[0]?.reason || "see criteria"}`
      : findings.find((f) => f.severity === "warning")
        ? `${findings.find((f) => f.severity === "warning")!.dimension} below threshold`
        : "All evaluated dimensions clear the 0.8 threshold.";

  const totalLatencyMs = Date.now() - t0;
  // Pricing per 1M tokens (as of 2026-05):
  //   gpt-4o-mini: $0.15 input / $0.60 output
  //   gpt-4o:      $2.50 input / $10.00 output
  // Pick rate based on the effort tier's actual model.
  const isGpt4o = effortConfig.model.startsWith("gpt-4o") && !effortConfig.model.includes("mini");
  const inputRate = isGpt4o ? 2.5 : 0.15;
  const outputRate = isGpt4o ? 10.0 : 0.6;
  const costUsd = Number(
    ((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000).toFixed(5),
  );

  return {
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    eventKind: event.kind,
    sourceRef: event.sourceRef,
    contentLength: event.content.length,
    contentExcerpt: event.content.slice(0, 400),
    overallSeverity: overallSeverity satisfies Finding["severity"],
    topFinding,
    findings: findings.sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity)),
    metadata: {
      model: event.model,
      prompt: event.prompt,
      llmCallsFired,
      totalLatencyMs,
      costUsd,
      effort,
      effortModel: effortConfig.model,
    },
  };
}

function suggestionFor(
  dim: string,
  severity: Finding["severity"],
  failed: Array<{ name: string; reason: string }>,
): string {
  if (severity === "pass") return "No action needed — passes the 0.8 threshold.";
  if (severity === "info") return `${dim} grader had no opinion on this content — treat as N/A.`;
  const primary = failed[0]?.name ?? "rubric concerns";
  if (dim === "safety") {
    return `Block + log via firewall pattern matching ${primary}. Add to red-team regression suite.`;
  }
  if (dim === "fairness") {
    return `Run the regenerate loop with improvement-instruction = "remove generalisations about protected classes". Open a policy-engine rule if this is a recurring pattern.`;
  }
  if (dim === "faithfulness") {
    return `Verify against the reference context. If response contradicts source, retrieve fresh context or refuse. Tag for prompt-engineering review.`;
  }
  if (dim === "privacy") {
    return `Redact via firewall DLP dictionaries. Audit the upstream call for PII leak — was the LLM given PII in the prompt?`;
  }
  return `Open a rubric-tuning ticket on the ${dim} deep config if this is a known false-positive.`;
}

/* ─── Output formatters ─────────────────────────────────────────── */

function formatPretty(report: TriageReport): string {
  const sevColor = (s: Finding["severity"]) =>
    s === "critical" ? chalk.bgRed.white(` ${s.toUpperCase()} `) :
    s === "warning" ? chalk.bgYellow.black(` ${s.toUpperCase()} `) :
    s === "info" ? chalk.bgBlue.white(` ${s.toUpperCase()} `) :
    chalk.bgGreen.black(` ${s.toUpperCase()} `);
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold.white("━━━ EvalGuard Triage ") + chalk.gray(report.generatedAt));
  lines.push(chalk.gray(`source: ${report.sourceRef}  ·  event: ${report.eventKind}  ·  content: ${report.contentLength} chars`));
  lines.push("");
  lines.push(`Overall: ${sevColor(report.overallSeverity)}  ${chalk.bold(report.topFinding)}`);
  lines.push("");
  lines.push(chalk.bold("Excerpt:"));
  lines.push(chalk.dim("  " + report.contentExcerpt.replace(/\n/g, "\n  ").slice(0, 300) + (report.contentExcerpt.length > 300 ? "…" : "")));
  lines.push("");
  lines.push(chalk.bold("Findings:"));
  for (const f of report.findings) {
    lines.push(
      `  ${sevColor(f.severity)}  ${chalk.bold(f.dimension.padEnd(14))} ` +
        `score=${(f.score * 10).toFixed(1)}/10  verdict=${f.verdict}`,
    );
    for (const c of f.failedCriteria.slice(0, 3)) {
      lines.push(chalk.dim(`     ✗ ${c.name}: ${c.reason.slice(0, 120)}`));
    }
    lines.push(chalk.cyan(`     → ${f.suggestedAction}`));
    lines.push("");
  }
  lines.push(chalk.gray(
    `Telemetry: effort=${report.metadata.effort} (${report.metadata.effortModel}) · ${report.metadata.llmCallsFired} LLM calls · ${report.metadata.totalLatencyMs}ms · $${report.metadata.costUsd}`,
  ));
  lines.push("");
  return lines.join("\n");
}

function formatMarkdown(report: TriageReport): string {
  const sevEmoji = (s: Finding["severity"]) =>
    s === "critical" ? "🔴" : s === "warning" ? "🟡" : s === "info" ? "🔵" : "🟢";
  const lines: string[] = [];
  lines.push(`# ${sevEmoji(report.overallSeverity)} EvalGuard Triage — ${report.eventKind}`);
  lines.push("");
  lines.push(`**Source:** \`${report.sourceRef}\`  ·  **Generated:** ${report.generatedAt}`);
  lines.push("");
  lines.push(`**Top finding:** ${report.topFinding}`);
  lines.push("");
  lines.push("## Excerpt");
  lines.push("```");
  lines.push(report.contentExcerpt.slice(0, 500));
  lines.push("```");
  lines.push("");
  lines.push("## Findings");
  lines.push("| Severity | Dimension | Score | Verdict | Top failed criterion |");
  lines.push("|---|---|---|---|---|");
  for (const f of report.findings) {
    const top = f.failedCriteria[0]?.name ?? "—";
    lines.push(
      `| ${sevEmoji(f.severity)} ${f.severity} | ${f.dimension} | ${(f.score * 10).toFixed(1)}/10 | ${f.verdict} | ${top} |`,
    );
  }
  lines.push("");
  lines.push("## Suggested actions");
  for (const f of report.findings.filter((x) => x.severity !== "pass")) {
    lines.push(`- **${f.dimension}:** ${f.suggestedAction}`);
  }
  lines.push("");
  lines.push(
    `_Telemetry: effort=${report.metadata.effort} (${report.metadata.effortModel}) · ${report.metadata.llmCallsFired} LLM calls · ${report.metadata.totalLatencyMs}ms · $${report.metadata.costUsd}_`,
  );
  return lines.join("\n");
}

/* ─── Command registration ─────────────────────────────────────────── */

export function registerInvestigate(program: Command): void {
  program
    .command("investigate")
    .description("Triage a single AI-safety event — OTLP span, firewall block, or LLM output JSON")
    .requiredOption("-i, --input <path>", "Path to event JSON file (or '-' for stdin)")
    .option("--format <format>", "Output format: json | pretty | markdown", "pretty")
    .option(
      "--effort <tier>",
      "Reasoning depth: low | medium | high | xhigh | max (default: medium)",
      "medium",
    )
    .action(async (opts: { input: string; format: "json" | "pretty" | "markdown"; effort?: string }) => {
      let raw: string;
      try {
        raw = opts.input === "-" ? await readStdin() : fs.readFileSync(opts.input, "utf-8");
      } catch (e) {
        console.error(chalk.red("Failed to read input:"), e instanceof Error ? e.message : e);
        process.exitCode = 1;
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error(chalk.red("Input is not valid JSON"));
        process.exitCode = 1;
        return;
      }

      const event = detectEvent(parsed, opts.input);
      let report: TriageReport;
      try {
        report = await investigate(event, { effort: opts.effort });
      } catch (e) {
        console.error(chalk.red("Investigation failed:"), e instanceof Error ? e.message : e);
        process.exitCode = 2;
        return;
      }

      const out =
        opts.format === "json"
          ? JSON.stringify(report, null, 2)
          : opts.format === "markdown"
            ? formatMarkdown(report)
            : formatPretty(report);
      process.stdout.write(out + "\n");

      // Exit code = severity → useful for CI integration where "critical"
      // findings should fail a build.
      if (report.overallSeverity === "critical") process.exitCode = 3;
      else if (report.overallSeverity === "warning") process.exitCode = 4;
      else process.exitCode = 0;
    });
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
