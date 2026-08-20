/**
 * `evalguard firewall-fairness-report` — firewall self-fairness audit (RB-10).
 *
 * Runs the org's firewall block/flag decisions through the fairness engine to
 * detect disparate impact across demographic / cohort groups (four-fifths rule)
 * — EU AI Act Art.10/15 + NIST AI RMF MEASURE 2.11 evidence. Use --fail-noncompliant
 * as a CI gate that breaks the build when the firewall blocks one group
 * disproportionately.
 *
 *   evalguard firewall-fairness-report --org <uuid>
 *   evalguard firewall-fairness-report --org <uuid> --group-key cohort --since 2026-06-01T00:00:00Z
 *   evalguard firewall-fairness-report --org <uuid> --json --fail-noncompliant
 *
 * Hits POST /api/v1/compliance/firewall-fairness with the user's API key.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { boundedFetch, decodeJsonBody, unwrapApiEnvelope } from "../lib/http.js";

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

export interface FirewallFairnessCliResult {
  surface: "firewall";
  totalDecisions: number;
  groupedDecisions: number;
  ungroupedDecisions: number;
  groups: string[];
  blockRatesByGroup: Record<string, number>;
  disparateImpact: { ratio: number; compliant: boolean };
  compliant: boolean;
  recommendations: string[];
  fairness: { overallScore: number };
  complianceRefs: { euAiAct: string; nistAiRmf: string };
}

/** Pure, unit-testable fetch. Throws on network / 4xx / 5xx. */
export async function fetchFirewallFairnessCli(opts: {
  body: Record<string, unknown>;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<FirewallFairnessCliResult> {
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const res = await fetchFn(`${opts.baseUrl}/compliance/firewall-fairness`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(opts.body),
  });
  // FAIL CLOSED via the shared boundary. This used to hand-roll
  // `res.text()` + `JSON.parse` + `json.data ?? json`, which passes an unrelated
  // 200 straight through to the renderer and treats a `success:false` envelope
  // as a result. See lib/http.ts, and the sbom-monitor note for the measured
  // case where the same shape rendered an empty body as "nothing configured".
  const decoded = await decodeJsonBody(res, "POST /firewall/fairness-report");
  if (!res.ok) {
    const detail = (decoded as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`firewall-fairness-report failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return unwrapApiEnvelope(decoded, "POST /firewall/fairness-report") as FirewallFairnessCliResult;
}

export function registerFirewallFairnessReport(program: Command): void {
  program
    .command("firewall-fairness-report")
    .description("Audit the firewall's OWN block decisions for disparate impact across groups (EU AI Act / NIST)")
    .requiredOption("--org <uuid>", "organization id to audit")
    .option("--project <uuid>", "restrict to a single project")
    .option("--group-key <key>", "decision-BOM metadata key holding the group (default: group)")
    .option("--since <iso>", "only audit decisions at/after this ISO timestamp")
    .option("--json", "output raw JSON")
    .option("--fail-noncompliant", "exit 1 when the audit is non-compliant (CI gate)")
    .action(async (options: Record<string, string | undefined>) => {
      const body: Record<string, unknown> = { orgId: options.org };
      if (options.project) body.projectId = options.project;
      if (options.groupKey) body.groupKey = options.groupKey;
      if (options.since) body.sinceISO = options.since;

      let result: FirewallFairnessCliResult;
      try {
        result = await fetchFirewallFairnessCli({ body, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const ok = result.compliant;
        const mark = ok ? chalk.green("● compliant") : chalk.red("● NON-COMPLIANT");
        console.log(`${mark}  firewall self-fairness  (${result.groupedDecisions}/${result.totalDecisions} decisions grouped)`);
        console.log(
          `    four-fifths ratio: ${(ok ? chalk.green : chalk.red)(result.disparateImpact.ratio.toFixed(3))} ${chalk.dim("(>= 0.80 passes)")}  ·  fairness ${result.fairness.overallScore}/100`,
        );
        const rates = Object.entries(result.blockRatesByGroup).sort((a, b) => b[1] - a[1]);
        for (const [g, rate] of rates) {
          console.log(`    ${chalk.dim(g)}: ${chalk.cyan(`${(rate * 100).toFixed(1)}% blocked`)}`);
        }
        if (result.ungroupedDecisions > 0) {
          console.log(chalk.dim(`    (${result.ungroupedDecisions} decisions had no '${options.groupKey ?? "group"}' tag — excluded from the math)`));
        }
        for (const rec of result.recommendations) console.log(`    ${chalk.dim("→")} ${rec}`);
        console.log(chalk.dim(`    refs: ${result.complianceRefs.euAiAct}; ${result.complianceRefs.nistAiRmf}`));
      }

      if (options.failNoncompliant && !result.compliant) {
        process.exit(1);
      }
    });
}
