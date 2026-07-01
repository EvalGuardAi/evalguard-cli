/**
 * `evalguard scorecard <repo>` — fetch the OpenSSF Scorecard project-health
 * signal (0-10) for a repository via the governed API.
 *
 *   evalguard scorecard github.com/lodash/lodash
 *   evalguard scorecard --json lodash/lodash
 *   evalguard scorecard --fail-below 5 owner/repo   # exit 1 if score < 5 (CI gate)
 *
 * Hits POST /api/v1/supply-chain/scorecard with the user's API key.
 */
import { Command } from "commander";
import chalk from "chalk";

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}
function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login --key <key>` first."));
    process.exit(1);
  }
  return k;
}

export interface ScorecardCliResult {
  repo: string;
  available: boolean;
  score?: number;
  riskScore?: number;
  checks?: Array<{ name: string; score: number; reason?: string }>;
  date?: string;
  error?: string;
}

/** Pure, unit-testable fetch. Throws on network / 4xx / 5xx. */
export async function fetchScorecardCli(opts: {
  repo: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ScorecardCliResult> {
  if (!opts.repo) throw new Error("repo is required");
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/supply-chain/scorecard`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ repo: opts.repo }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`scorecard failed (${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return (json.data ?? json) as ScorecardCliResult;
}

export function registerScorecard(program: Command): void {
  program
    .command("scorecard <repo>")
    .description("Fetch the OpenSSF Scorecard project-health signal for a repository")
    .option("--json", "output raw JSON")
    .option("--fail-below <min>", "exit 1 if the score is below this threshold (CI gate)")
    .action(async (repo: string, options: { json?: boolean; failBelow?: string }) => {
      let result: ScorecardCliResult;
      try {
        result = await fetchScorecardCli({ repo, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!result.available) {
        console.log(`${chalk.yellow("•")} ${result.repo} — no scorecard available (${result.error ?? "unknown"})`);
      } else {
        const s = result.score ?? 0;
        const color = s >= 7 ? chalk.green : s >= 4 ? chalk.yellow : chalk.red;
        console.log(`${color("●")} ${result.repo} — OpenSSF Scorecard ${color(`${s}/10`)} (risk ${result.riskScore}/10)${result.date ? chalk.dim(` · ${result.date}`) : ""}`);
        for (const c of (result.checks ?? []).filter((c) => c.score >= 0).sort((a, b) => a.score - b.score).slice(0, 8)) {
          console.log(`    ${chalk.dim(c.name)}: ${c.score}/10`);
        }
      }

      if (options.failBelow && result.available && (result.score ?? 0) < Number(options.failBelow)) {
        process.exit(1);
      }
    });
}
