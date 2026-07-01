/**
 * `evalguard consensus` — multi-LLM consensus over N model responses (G13).
 *
 * You provide each model's answer to the same prompt; this returns the consensus
 * answer + an agreement score (use --min-agreement as a CI gate for high-stakes
 * generations).
 *
 *   evalguard consensus -c gpt-4o=a.txt -c claude=b.txt -c gemini=c.txt
 *   evalguard consensus --input candidates.json --json
 *   evalguard consensus -c m1=a.txt -c m2=b.txt --min-agreement 0.66   # exit 1 if below
 *
 * Hits POST /api/v1/gateway/consensus with the user's API key.
 */
import { readFileSync } from "node:fs";
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

export interface ConsensusCandidateInput {
  model: string;
  content?: string;
  error?: string;
}

export interface ConsensusCliResult {
  chosen: string | null;
  chosenModels: string[];
  agreement: number;
  isMajority: boolean;
  method: string;
  clusters: Array<{ representative: string; models: string[]; size: number }>;
  candidateCount: number;
  successCount: number;
  errorCount: number;
}

/** Parse repeated `-c model=path` flags into candidates (reading each file). */
export function parseCandidateFlags(pairs: string[]): ConsensusCandidateInput[] {
  return pairs.map((p) => {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new Error(`--candidate must be model=path, got "${p}"`);
    const model = p.slice(0, eq).trim();
    const path = p.slice(eq + 1).trim();
    if (!model || !path) throw new Error(`--candidate must be model=path, got "${p}"`);
    return { model, content: readFileSync(path, "utf8") };
  });
}

/** Pure, unit-testable fetch. Throws on network / 4xx / 5xx. */
export async function fetchConsensusCli(opts: {
  body: { candidates: ConsensusCandidateInput[]; method?: string; threshold?: number };
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ConsensusCliResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/gateway/consensus`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`consensus failed (${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return (json.data ?? json) as ConsensusCliResult;
}

export function registerConsensus(program: Command): void {
  program
    .command("consensus")
    .description("Multi-LLM consensus over N model responses (returns agreed answer + agreement)")
    .option("-c, --candidate <model=path>", "a model's response file (repeatable)", (v: string, acc: string[]) => { acc.push(v); return acc; }, [] as string[])
    .option("--input <json>", "JSON file: array of { model, content } (alternative to -c)")
    .option("--method <method>", "similarity (default) | exact")
    .option("--threshold <n>", "similarity threshold 0-1 to join a cluster (default 0.8)")
    .option("--min-agreement <n>", "exit 1 if agreement is below this (CI gate)")
    .option("--json", "output raw JSON")
    .action(async (options: { candidate: string[]; input?: string; method?: string; threshold?: string; minAgreement?: string; json?: boolean }) => {
      let candidates: ConsensusCandidateInput[];
      try {
        if (options.input) {
          const parsed = JSON.parse(readFileSync(options.input, "utf8"));
          if (!Array.isArray(parsed)) throw new Error("--input file must be a JSON array of { model, content }");
          candidates = parsed;
        } else {
          candidates = parseCandidateFlags(options.candidate ?? []);
        }
        if (candidates.length === 0) throw new Error("provide candidates via -c model=path (repeatable) or --input <json>");
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      const body: { candidates: ConsensusCandidateInput[]; method?: string; threshold?: number } = { candidates };
      if (options.method) body.method = options.method;
      if (options.threshold !== undefined) body.threshold = Number(options.threshold);

      let result: ConsensusCliResult;
      try {
        result = await fetchConsensusCli({ body, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const pct = Math.round(result.agreement * 100);
        const color = result.isMajority ? chalk.green : pct >= 34 ? chalk.yellow : chalk.red;
        console.log(`${color("●")} Consensus: ${color(`${pct}% agreement`)} ${result.isMajority ? chalk.green("(majority)") : chalk.yellow("(no majority)")} · ${result.successCount}/${result.candidateCount} models${result.errorCount ? chalk.dim(` (${result.errorCount} errored)`) : ""}`);
        if (result.chosen) {
          console.log(chalk.dim(`  agreed by: ${result.chosenModels.join(", ")}`));
          console.log(`  ${result.chosen.length > 280 ? result.chosen.slice(0, 280) + "…" : result.chosen}`);
        } else {
          console.log(chalk.red("  no consensus answer (all candidates errored)"));
        }
        if (result.clusters.length > 1) {
          console.log(chalk.dim(`  ${result.clusters.length} distinct answer clusters: ${result.clusters.map((c) => `${c.size}×`).join(", ")}`));
        }
      }

      if (options.minAgreement !== undefined && result.agreement < Number(options.minAgreement)) {
        process.exit(1);
      }
    });
}
