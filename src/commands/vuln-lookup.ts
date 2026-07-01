/**
 * `evalguard vuln-lookup <purl...>` — look up known vulnerabilities for one or
 * more Package URLs (PURLs) via OSV.dev, through the governed API.
 *
 *   evalguard vuln-lookup pkg:npm/lodash@4.17.21 pkg:pypi/requests@2.31.0
 *   evalguard vuln-lookup --json pkg:npm/lodash@4.17.21
 *   evalguard vuln-lookup --fail-on-vuln pkg:npm/lodash@4.17.21   # exit 1 if any vulnerable (CI gate)
 *
 * Hits POST /api/v1/supply-chain/lookup with the user's API key. Supported
 * ecosystems: npm, PyPI, Go. Invalid/unsupported PURLs are reported, not hidden.
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

export interface VulnLookupEntry {
  purl: string;
  status: "ok" | "unsupported" | "invalid";
  ecosystem?: string;
  name?: string;
  version?: string;
  vulnerabilities?: Array<{ id: string; severity?: string; summary?: string }>;
  reason?: string;
}
export interface VulnLookupResult {
  entries: VulnLookupEntry[];
  summary: { total: number; queried: number; unsupported: number; invalid: number; vulnerable: number; vulnerabilitiesFound: number };
  truncatedAdvisoryCount: number;
}

/** Pure, unit-testable lookup. Throws on network / 4xx / 5xx. */
export async function lookupVulns(opts: {
  purls: string[];
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<VulnLookupResult> {
  if (!opts.purls.length) throw new Error("at least one PURL is required");
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/supply-chain/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ purls: opts.purls }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`lookup failed (${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return (json.data ?? json) as VulnLookupResult;
}

export function registerVulnLookup(program: Command): void {
  program
    .command("vuln-lookup <purls...>")
    .description("Look up known vulnerabilities for Package URLs (PURLs) via OSV")
    .option("--json", "output raw JSON")
    .option("--fail-on-vuln", "exit 1 if any PURL is vulnerable (CI gate)")
    .action(async (purls: string[], options: { json?: boolean; failOnVuln?: boolean }) => {
      let result: VulnLookupResult;
      try {
        result = await lookupVulns({ purls, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const e of result.entries) {
          if (e.status !== "ok") {
            console.log(`${chalk.dim("•")} ${e.purl} — ${chalk.yellow(e.status)} (${e.reason ?? ""})`);
            continue;
          }
          const n = e.vulnerabilities?.length ?? 0;
          if (n === 0) {
            console.log(`${chalk.green("✓")} ${e.purl} — no known vulnerabilities`);
          } else {
            console.log(`${chalk.red("✗")} ${e.purl} — ${chalk.red(`${n} vulnerabilit${n === 1 ? "y" : "ies"}`)}`);
            for (const v of e.vulnerabilities!) {
              console.log(`    ${chalk.dim(v.id)}${v.severity ? ` [${v.severity}]` : ""} ${(v.summary ?? "").slice(0, 100)}`);
            }
          }
        }
        const s = result.summary;
        console.log(
          chalk.dim(
            `\n${s.queried} queried · ${s.vulnerable} vulnerable · ${s.vulnerabilitiesFound} advisories` +
              (s.unsupported ? ` · ${s.unsupported} unsupported` : "") +
              (s.invalid ? ` · ${s.invalid} invalid` : "") +
              (result.truncatedAdvisoryCount ? ` · ${result.truncatedAdvisoryCount} truncated` : ""),
          ),
        );
      }

      if (options.failOnVuln && result.summary.vulnerable > 0) {
        process.exit(1);
      }
    });
}
