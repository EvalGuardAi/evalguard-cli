/**
 * `evalguard governance-risk` — composite multi-axis AI governance risk score (G12).
 *
 * Combines the per-axis risk signals you pass into one weighted 0-100 score with
 * a per-axis breakdown. Useful as a CI gate (--fail-above) for an overall posture.
 *
 *   evalguard governance-risk --supply-chain 6 --compliance 80 --eval-pass-rate 0.9
 *   evalguard governance-risk --security-findings '{"critical":1,"high":3}' --json
 *   evalguard governance-risk --supply-chain 9 --fail-above 70   # exit 1 if composite > 70
 *
 * Hits POST /api/v1/governance/risk with the user's API key.
 */
import { Command } from "commander";
import chalk from "chalk";
import { parseGateThreshold } from "../lib/gate-threshold.js";
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

export interface GovernanceRiskCliResult {
  overallScore: number;
  level: "low" | "medium" | "high" | "critical";
  axes: Array<{ key: string; name: string; score: number; weight: number; detail: string }>;
  missingAxes: string[];
  recommendations: string[];
}

function parseSeverity(raw: string | undefined, flag: string): Record<string, number> | undefined {
  if (!raw) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`${flag} must be JSON, e.g. '{"critical":1,"high":2}'`);
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return obj as Record<string, number>;
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`expected a number, got "${raw}"`);
  return n;
}

/** Pure, unit-testable fetch. Throws on network / 4xx / 5xx. */
export async function fetchGovernanceRiskCli(opts: {
  body: Record<string, unknown>;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<GovernanceRiskCliResult> {
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const res = await fetchFn(`${opts.baseUrl}/governance/risk`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(opts.body),
  });
  // FAIL CLOSED via the shared boundary. This used to hand-roll
  // `res.text()` + `JSON.parse` + `json.data ?? json`, which passes an unrelated
  // 200 straight through to the renderer and treats a `success:false` envelope
  // as a result. See lib/http.ts, and the sbom-monitor note for the measured
  // case where the same shape rendered an empty body as "nothing configured".
  const decoded = await decodeJsonBody(res, "POST /governance/risk");
  if (!res.ok) {
    const detail = (decoded as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`governance-risk failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return unwrapApiEnvelope(decoded, "POST /governance/risk") as GovernanceRiskCliResult;
}

export function registerGovernanceRisk(program: Command): void {
  program
    .command("governance-risk")
    .description("Composite multi-axis AI governance risk score (0-100) from per-axis signals")
    .option("--security-findings <json>", 'security scan severity counts, e.g. \'{"critical":1,"high":2}\'')
    .option("--supply-chain <score>", "supply-chain risk 0-10")
    .option("--vulnerability <score>", "vulnerability posture risk 0-10")
    .option("--compliance <pct>", "compliance framework coverage 0-100 (higher = better)")
    .option("--firewall-hits <json>", 'firewall blocked-event severity counts, e.g. \'{"high":4}\'')
    .option("--eval-pass-rate <rate>", "eval pass rate 0-1 (higher = better)")
    .option("--json", "output raw JSON")
    .option("--fail-above <score>", "exit 1 if the composite score exceeds this threshold (CI gate)")
    .action(async (options: Record<string, string | undefined>) => {
      let body: Record<string, unknown>;
      try {
        body = {
          securityFindings: parseSeverity(options.securityFindings, "--security-findings"),
          supplyChainScore: num(options.supplyChain),
          vulnerabilityScore: num(options.vulnerability),
          complianceCoverage: num(options.compliance),
          firewallHits: parseSeverity(options.firewallHits, "--firewall-hits"),
          evalPassRate: num(options.evalPassRate),
        };
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }
      // strip undefined so we don't send empty keys
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      if (Object.keys(body).length === 0) {
        console.error(chalk.red("✗ provide at least one axis (e.g. --supply-chain 6)"));
        process.exit(1);
        return;
      }

      let result: GovernanceRiskCliResult;
      try {
        result = await fetchGovernanceRiskCli({ body, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const color =
          result.level === "critical" || result.level === "high" ? chalk.red
          : result.level === "medium" ? chalk.yellow
          : chalk.green;
        console.log(`${color("●")} Governance risk: ${color(`${result.overallScore}/100`)} (${color(result.level)})`);
        for (const ax of result.axes) {
          const ac = ax.score >= 7 ? chalk.red : ax.score >= 4 ? chalk.yellow : chalk.green;
          console.log(`    ${chalk.dim(ax.name)}: ${ac(`${ax.score.toFixed(1)}/10`)} ${chalk.dim(`(w${ax.weight}) · ${ax.detail}`)}`);
        }
        if (result.missingAxes.length) {
          console.log(chalk.dim(`    (no data: ${result.missingAxes.join(", ")} — score is partial)`));
        }
        for (const rec of result.recommendations) console.log(`    ${chalk.dim("→")} ${rec}`);
      }

      if (
        options.failAbove !== undefined &&
        result.overallScore > parseGateThreshold(options.failAbove, "--fail-above", { min: 0, max: 100 })
      ) {
        process.exit(1);
      }
    });
}
