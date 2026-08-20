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
import { parsePurl } from "@evalguard/core";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { failExit } from "../lib/poll.js";
import { boundedFetch, decodeJsonBody, expectArrayField, expectField, unwrapApiEnvelope } from "../lib/http.js";
import { refuseArgument } from "../lib/arg-validate.js";

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
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const res = await fetchFn(`${opts.baseUrl}/supply-chain/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ purls: opts.purls }),
  });
  // FAIL CLOSED via the shared boundary. This used to hand-roll
  // `res.text()` + `JSON.parse` + `json.data ?? json`, which passes an unrelated
  // 200 straight through to the renderer and treats a `success:false` envelope
  // as a result. See lib/http.ts, and the sbom-monitor note for the measured
  // case where the same shape rendered an empty body as "nothing configured".
  const decoded = await decodeJsonBody(res, "POST /supply-chain/vuln-lookup");
  if (!res.ok) {
    const detail = (decoded as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`lookup failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  // `as VulnLookupResult` is a cast, not a check — so a 200 whose body had no
  // `entries` reached the renderer's `for (const e of result.entries)` and died
  // as `TypeError: result.entries is not iterable`, an unhandled stack rather
  // than a refusal naming the server. `entries` + `summary` are what this route
  // always sends.
  const data = unwrapApiEnvelope(decoded, "POST /supply-chain/vuln-lookup");
  expectArrayField(data, "entries", "POST /supply-chain/vuln-lookup");
  expectField(data, "summary", "POST /supply-chain/vuln-lookup");
  return data as VulnLookupResult;
}

/**
 * Refuse PURLs that are not PURLs, before the request.
 *
 * The boundary is deliberately narrow: SYNTAX only. `parsePurl` is imported
 * from `@evalguard/core` — the very function the server runs — so the CLI and
 * the route agree by construction instead of by a second regex that drifts.
 *
 * What is NOT rejected here, on purpose: an unsupported ECOSYSTEM
 * (`pkg:cargo/serde@1.0`) still goes to the server, because the route's
 * documented contract is that unsupported PURLs are reported in-band with a
 * reason — that reporting is useful and must not be swallowed by a client-side
 * allow-list of four ecosystems that would then need updating in two places.
 * A string that is not a `pkg:` URL at all carries no such information; it is a
 * typo, and the only useful answer is to name it.
 */
function assertPurlsWellFormed(purls: string[]): void {
  const malformed = purls.filter((p) => parsePurl(p) === null);
  if (malformed.length === 0) return;
  refuseArgument(
    `Invalid PURL${malformed.length === 1 ? "" : "s"}: ${malformed.map((p) => JSON.stringify(p)).join(", ")} ` +
      `— not a valid pkg: URL (expected e.g. pkg:npm/lodash@4.17.21).`,
    "Nothing was looked up. An unsupported ECOSYSTEM is still reported in-band by the server; " +
      "this refusal is only for strings that are not Package URLs at all.",
  );
}

export function registerVulnLookup(program: Command): void {
  program
    .command("vuln-lookup <purls...>")
    .description("Look up known vulnerabilities for Package URLs (PURLs) via OSV")
    .option("--json", "output raw JSON")
    .option("--fail-on-vuln", "exit 1 if any PURL is vulnerable (CI gate)")
    .action(async (purls: string[], options: { json?: boolean; failOnVuln?: boolean }) => {
      assertPurlsWellFormed(purls);
      let result: VulnLookupResult;
      try {
        result = await lookupVulns({ purls, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        // process.exitCode, not process.exit(): the lookup's undici sockets are
        // still in teardown here, and exiting mid-teardown trips a libuv
        // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` abort that
        // replaces the intended exit 1 with 127 on Windows. Same guard as
        // reportFatal() in src/index.ts and failExit() in src/lib/poll.ts.
        failExit(chalk.red("✗ ") + (err as Error).message);
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
        // Last statement of the action — setting exitCode is equivalent and
        // avoids the mid-teardown libuv abort described above.
        process.exitCode = 1;
      }
    });
}
