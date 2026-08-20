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
import { parseGateThreshold } from "../lib/gate-threshold.js";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { failExit } from "../lib/poll.js";
import { boundedFetch, decodeJsonBody, expectBooleanField, expectResult } from "../lib/http.js";

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
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const res = await fetchFn(`${opts.baseUrl}/supply-chain/scorecard`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ repo: opts.repo }),
  });
  // FAIL CLOSED via the shared boundary. This used to hand-roll
  // `res.text()` + `JSON.parse` + `json.data ?? json`, which passes an unrelated
  // 200 straight through to the renderer and treats a `success:false` envelope
  // as a result. See lib/http.ts, and the sbom-monitor note for the measured
  // case where the same shape rendered an empty body as "nothing configured".
  const decoded = await decodeJsonBody(res, "POST /supply-chain/scorecard");
  if (!res.ok) {
    const detail = (decoded as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`scorecard failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  // `unwrapApiEnvelope` alone still let an unrelated 200 through: measured,
  // `{"hello":"world"}` and `{"success":true,"data":{}}` both printed
  //     • undefined — no scorecard available (unknown)
  // and exited 0, because `available` was `undefined` and every renderer here
  // spells falsy as the "nothing to see" branch. `repo` + a BOOLEAN `available`
  // are the two fields that make this body this route's answer.
  const result = expectResult<ScorecardCliResult>(
    decoded,
    "POST /supply-chain/scorecard",
    ["repo"],
  );
  expectBooleanField(result, "available", "POST /supply-chain/scorecard");
  return result;
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
        // process.exitCode, not process.exit(): the just-failed request's
        // undici sockets are still tearing down, and exiting mid-teardown
        // trips a libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
        // abort that replaces the intended exit 1 with 127 on Windows.
        // Same guard as reportFatal() in src/index.ts.
        failExit(chalk.red("✗ ") + (err as Error).message);
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

      if (options.failBelow !== undefined) {
        const min = parseGateThreshold(options.failBelow, "--fail-below", { min: 0, max: 10 });
        // Fail CLOSED when there is no scorecard at all: `--fail-below` asks
        // "prove this repo meets the bar", and an unavailable scorecard is not
        // proof (audit L15). Previously `result.available &&` made a repo with
        // no scorecard pass the gate silently.
        if (!result.available) {
          console.error(
            chalk.red(`No OpenSSF Scorecard available for ${result.repo} — cannot satisfy --fail-below ${min}.`),
          );
          // `return` is load-bearing: process.exit() halted here, whereas
          // setting exitCode alone would fall through to the score check below.
          process.exitCode = 1;
          return;
        }
        if ((result.score ?? 0) < min) {
          process.exitCode = 1;
        }
      }
    });
}
