/**
 * `evalguard incident-rca` — alert-triggered autonomous RCA loop (G6) on demand.
 *
 * Runs the same RCA orchestrator (error-classifier + trace-assistant) the worker
 * fires automatically on error_spike / sla_breach alerts, over a trace window
 * you pick. Returns the probable cause, evidence trace ids, and recommendations.
 *
 *   evalguard incident-rca --project <uuid>
 *   evalguard incident-rca --project <uuid> --trigger sla_breach --window 120
 *   evalguard incident-rca --project <uuid> --json
 *
 * Hits POST /api/v1/incidents/rca with the user's API key.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectArrayField,
  expectField,
  expectObject,
  unwrapApiEnvelope,
} from "../lib/http.js";

function baseUrl(): string {
  return resolveBaseUrl();
}
function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login --key <key>` first."));
    process.exit(1);
  }
  return k;
}

export interface IncidentRcaCliResult {
  trigger: "error_spike" | "sla_breach";
  projectId: string;
  probableCause: string;
  severity: "critical" | "high" | "medium" | "low";
  evidenceTraceIds: string[];
  evidenceSpanIds: string[];
  classifiedErrors: Array<{ type: string; severity: string; count: number; rootCause: string; recommendation: string }>;
  recommendations: string[];
  stats: { spansAnalyzed: number; errorSpans: number; tracesAnalyzed: number; distinctErrorTypes: number };
  rootCauseText: string;
}

/** Pure, unit-testable fetch. Throws on network / 4xx / 5xx. */
export async function fetchIncidentRcaCli(opts: {
  body: Record<string, unknown>;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<IncidentRcaCliResult> {
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const res = await fetchFn(`${opts.baseUrl}/incidents/rca`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(opts.body),
  });
  // FAIL CLOSED via the shared boundary. This used to hand-roll
  // `res.text()` + `JSON.parse` + `json.data ?? json`, which passes an unrelated
  // 200 straight through to the renderer and treats a `success:false` envelope
  // as a result. See lib/http.ts, and the sbom-monitor note for the measured
  // case where the same shape rendered an empty body as "nothing configured".
  const decoded = await decodeJsonBody(res, "POST /incidents/rca");
  if (!res.ok) {
    const detail = (decoded as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`incident-rca failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const payload = unwrapApiEnvelope(decoded, "POST /incidents/rca");
  // The renderer reads `result.stats.spansAnalyzed` and
  // `result.evidenceTraceIds.length` unguarded; a body missing either threw a
  // raw `Cannot read properties of undefined` instead of saying the response
  // was not this endpoint's answer. Assert the two structural fields here, at
  // the fetch, so every caller of this function gets the same guarantee.
  expectObject(expectField(payload, "stats", "POST /incidents/rca"), "POST /incidents/rca .stats");
  expectArrayField(payload, "evidenceTraceIds", "POST /incidents/rca");
  expectArrayField(payload, "classifiedErrors", "POST /incidents/rca");
  expectArrayField(payload, "recommendations", "POST /incidents/rca");
  return payload as IncidentRcaCliResult;
}

export function registerIncidentRca(program: Command): void {
  program
    .command("incident-rca")
    .description("Run the alert-triggered RCA loop (error-classifier + trace-assistant) over a trace window")
    .requiredOption("--project <uuid>", "project id to analyze")
    .option("--trigger <kind>", "error_spike | sla_breach", "error_spike")
    .option("--window <minutes>", "lookback window in minutes", "60")
    .option("--llm", "use the LLM trace-assistant step (default: rule-based only)")
    .option("--json", "output raw JSON")
    .action(async (options: Record<string, string | boolean | undefined>) => {
      const trigger = String(options.trigger ?? "error_spike");
      if (trigger !== "error_spike" && trigger !== "sla_breach") {
        console.error(chalk.red("✗ --trigger must be error_spike or sla_breach"));
        process.exit(1);
        return;
      }
      const windowMinutes = Number(options.window ?? 60);
      if (!Number.isFinite(windowMinutes) || windowMinutes < 1) {
        console.error(chalk.red("✗ --window must be a positive number of minutes"));
        process.exit(1);
        return;
      }

      const body: Record<string, unknown> = {
        projectId: String(options.project),
        trigger,
        windowMinutes,
        useLLM: Boolean(options.llm),
      };

      let result: IncidentRcaCliResult;
      try {
        result = await fetchIncidentRcaCli({ body, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const color =
        result.severity === "critical" || result.severity === "high"
          ? chalk.red
          : result.severity === "medium"
            ? chalk.yellow
            : chalk.green;
      console.log(`${color("●")} RCA (${result.trigger}) — severity ${color(result.severity)}`);
      console.log(`    ${chalk.bold("Probable cause:")} ${result.probableCause}`);
      console.log(
        chalk.dim(
          `    Analyzed ${result.stats.spansAnalyzed} span(s) / ${result.stats.tracesAnalyzed} trace(s); ` +
            `${result.stats.errorSpans} errored, ${result.stats.distinctErrorTypes} error type(s).`,
        ),
      );
      for (const e of result.classifiedErrors.slice(0, 5)) {
        console.log(`    ${chalk.dim("•")} ${e.type} ×${e.count} (${e.severity}) — ${e.rootCause}`);
      }
      if (result.evidenceTraceIds.length) {
        console.log(chalk.dim(`    Evidence traces: ${result.evidenceTraceIds.slice(0, 5).join(", ")}${result.evidenceTraceIds.length > 5 ? " …" : ""}`));
      }
      for (const rec of result.recommendations) console.log(`    ${chalk.dim("→")} ${rec}`);
    });
}
