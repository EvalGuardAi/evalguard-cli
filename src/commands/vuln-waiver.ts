/**
 * `evalguard vuln-waiver …` — manage per-CVE waivers (G2). Waiver-file model:
 * waive a specific (CVE, package) tuple so it stops failing the supply-chain CI
 * gate while the finding stays VISIBLE in scan output. A waiver carries a reason
 * (audit) and an optional expiry (the CVE re-surfaces once the waiver lapses).
 *
 *   evalguard vuln-waiver add --project <id> --cve CVE-2024-3660 --package keras --reason "patched in app layer"
 *   evalguard vuln-waiver add --project <id> --cve CVE-2024-3660 --package keras --reason "tracking" --expires 2026-12-31T00:00:00Z
 *   evalguard vuln-waiver list --project <id>
 *   evalguard vuln-waiver list --project <id> --json
 *   evalguard vuln-waiver remove <id>
 *
 * Hits /api/v1/supply-chain/waivers with the user's API key. Writes require
 * owner/admin on the project's org.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { failExit } from "../lib/poll.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectArrayField,
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

interface WaiverRecord {
  id: string;
  projectId: string;
  orgId: string;
  cveId: string;
  affectedPackage: string;
  severity: string | null;
  reason: string;
  expiresAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

async function apiFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await boundedFetch(`${baseUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  // FAIL CLOSED via the shared boundary. This used to hand-roll
  // `res.text()` + `JSON.parse` + `json.data ?? json`, which passes an unrelated
  // 200 straight through to the renderer and treats a `success:false` envelope
  // as a result. See lib/http.ts, and the sbom-monitor note for the measured
  // case where the same shape rendered an empty body as "nothing configured".
  const decoded = await decodeJsonBody(res, path);
  if (!res.ok) {
    const detail = (decoded as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return unwrapApiEnvelope(decoded, path) as T;
}

export function registerVulnWaiver(program: Command): void {
  const cmd = program
    .command("vuln-waiver")
    .description("Manage per-CVE waivers for the supply-chain CI gate");

  cmd
    .command("add")
    .description("Waive a (CVE, package) so it stops failing the gate but stays visible")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--cve <id>", "CVE / advisory id, e.g. CVE-2024-3660")
    .requiredOption("--package <pkg>", "Affected package name")
    .requiredOption("--reason <r>", "Why this is waived (audit trail)")
    .option("--expires <iso>", "ISO expiry; the CVE re-surfaces after this (default: never)")
    .action(
      async (opts: { project: string; cve: string; package: string; reason: string; expires?: string }) => {
        try {
          const { waiver } = await apiFetch<{ waiver: WaiverRecord }>(
            "/supply-chain/waivers",
            "POST",
            {
              projectId: opts.project,
              cveId: opts.cve,
              affectedPackage: opts.package,
              reason: opts.reason,
              expiresAt: opts.expires ?? null,
            },
          );
          console.log(
            `${chalk.green("✓")} Waived ${chalk.cyan(waiver.cveId)} for ${chalk.cyan(waiver.affectedPackage)} ` +
              chalk.dim(`(id ${waiver.id}${waiver.expiresAt ? `, expires ${waiver.expiresAt}` : ", no expiry"})`),
          );
        } catch (err) {
          console.error(chalk.red("✗ ") + (err as Error).message);
          process.exit(1);
        }
      },
    );

  cmd
    .command("list")
    .description("List a project's CVE waivers")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "output raw JSON")
    .action(async (opts: { project: string; json?: boolean }) => {
      try {
        const raw = await apiFetch<unknown>(
          `/supply-chain/waivers?projectId=${encodeURIComponent(opts.project)}`,
          "GET",
        );
        // `result.waivers.length` on a body without `waivers` threw a raw
        // `Cannot read properties of undefined (reading 'length')` at the user.
        // It exited non-zero, so it was not a fail-OPEN — but "the response was
        // not this endpoint's answer" is the actual fact, and that is what the
        // operator needs to read in a CI log.
        const result = {
          waivers: expectArrayField(raw, "waivers", "GET /supply-chain/waivers") as WaiverRecord[],
          total: (raw as { total?: number })?.total ?? 0,
        };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.waivers.length === 0) {
          console.log(chalk.dim("No CVE waivers for this project."));
          return;
        }
        for (const w of result.waivers) {
          const expiry = w.expiresAt
            ? new Date(w.expiresAt).getTime() < Date.now()
              ? chalk.yellow(`expired ${w.expiresAt}`)
              : chalk.dim(`expires ${w.expiresAt}`)
            : chalk.dim("no expiry");
          console.log(
            `${chalk.cyan(w.cveId)} ${chalk.dim("·")} ${w.affectedPackage} ${chalk.dim("·")} ${expiry}`,
          );
          console.log(`    ${chalk.dim(w.id)} — ${w.reason}`);
        }
        console.log(chalk.dim(`\n${result.total} waiver${result.total === 1 ? "" : "s"}`));
      } catch (err) {
        failExit(chalk.red("✗ ") + (err as Error).message);
        return;
      }
    });

  cmd
    .command("remove <id>")
    .description("Revoke a waiver (re-exposes its CVE to the gate)")
    .action(async (id: string) => {
      try {
        await apiFetch<{ deleted: boolean }>(
          `/supply-chain/waivers/${encodeURIComponent(id)}`,
          "DELETE",
        );
        console.log(`${chalk.green("✓")} Removed waiver ${chalk.dim(id)}`);
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
      }
    });
}
