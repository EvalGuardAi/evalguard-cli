/**
 * `evalguard cost-export <orgId>` — FinOps cost interchange export.
 *
 * Surfaces the FinOps EXPORT CONNECTORS (server route
 * GET /api/v1/cost/export?format=focus|openmeter|lago) on the terminal so a
 * FinOps / procurement team can pull an org's row-level LLM spend in the
 * standard interchange formats they already ingest:
 *
 *   focus      FinOps Foundation FOCUS 1.0 columnar billing CSV — lands in
 *              the same data lake as cloud spend (CUDOS / Cloudability / Apptio).
 *   openmeter  OpenMeter CloudEvents usage events (NDJSON, one `llm.usage` per line).
 *   lago       Lago usage-event JSON (NDJSON, one `{ event: {…} }` per line).
 *
 * This is row-level interchange and is DISTINCT from `evalguard budget` (live
 * spend gauges) and the chargeback aggregate report. The CLI does NOT
 * re-serialize or re-price anything — the server is canonical; we stream the
 * exact bytes it returns to stdout or a file. If the server returns 4xx/5xx we
 * print the error and exit non-zero so the file is never half-written.
 *
 *   evalguard cost-export <orgId> --format focus
 *   evalguard cost-export <orgId> --format lago --start 2026-05-01 --end 2026-05-31 --out spend.ndjson
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const COST_EXPORT_FORMATS = ["focus", "openmeter", "lago"] as const;
export type CostExportFormat = (typeof COST_EXPORT_FORMATS)[number];

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}

function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(
      chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login` first or export the key."),
    );
    process.exit(1);
  }
  return k;
}

/**
 * Pure, directly-unit-testable fetcher. Builds the query, hits the server,
 * and returns the raw export bytes + the server-suggested filename. Throws on
 * bad input / network / 4xx / 5xx. No client-side re-serialization.
 */
export async function fetchCostExport(opts: {
  orgId: string;
  format: CostExportFormat;
  projectId?: string;
  start?: string;
  end?: string;
  currency?: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ body: string; contentType: string; suggestedFilename: string }> {
  if (!UUID_RE.test(opts.orgId)) {
    throw new Error(`orgId must be a valid UUID. Got: ${opts.orgId}`);
  }
  if (opts.projectId && !UUID_RE.test(opts.projectId)) {
    throw new Error(`projectId must be a valid UUID. Got: ${opts.projectId}`);
  }
  if (!(COST_EXPORT_FORMATS as readonly string[]).includes(opts.format)) {
    throw new Error(`format must be one of: ${COST_EXPORT_FORMATS.join(", ")}`);
  }

  const params = new URLSearchParams({ format: opts.format, orgId: opts.orgId });
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.start) params.set("startDate", opts.start);
  if (opts.end) params.set("endDate", opts.end);
  if (opts.currency) params.set("currency", opts.currency);

  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/cost/export?${params.toString()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      detail = ` (${j.error?.code ?? "ERROR"}: ${j.error?.message ?? "unknown"})`;
    } catch {
      try {
        detail = ` — ${(await res.text()).slice(0, 400)}`;
      } catch {
        /* best-effort body capture */
      }
    }
    throw new Error(`Cost export failed: HTTP ${res.status}${detail}`);
  }

  const body = await res.text();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const ext = opts.format === "focus" ? "csv" : "ndjson";
  const fallback = `evalguard-cost-${opts.format}-${opts.orgId.slice(0, 8)}.${ext}`;
  return {
    body,
    contentType: res.headers.get("content-type") ?? (opts.format === "focus" ? "text/csv" : "application/x-ndjson"),
    suggestedFilename: m?.[1] ?? fallback,
  };
}

export function registerCostExport(program: Command): void {
  program
    .command("cost-export")
    .description("Export an org's LLM cost data in a FinOps interchange format (FOCUS / OpenMeter / Lago)")
    .argument("<orgId>", "Org UUID to export cost data for")
    .option("-f, --format <fmt>", "Interchange format: focus | openmeter | lago", "focus")
    .option("-p, --project <projectId>", "Narrow the export to a single project")
    .option("--start <date>", "Start date (ISO, e.g. 2026-05-01). Default: first of current month")
    .option("--end <date>", "End date (ISO, e.g. 2026-05-31). Default: now")
    .option("--currency <code>", "ISO currency label for FOCUS / Lago (default USD)")
    .option("-o, --out <path>", "Write to file (default: print to stdout)")
    .action(
      async (
        orgId: string,
        opts: { format: string; project?: string; start?: string; end?: string; currency?: string; out?: string },
      ) => {
        const fmt = opts.format.toLowerCase();
        if (!(COST_EXPORT_FORMATS as readonly string[]).includes(fmt)) {
          console.error(chalk.red(`Unknown format: ${opts.format}. Choose: ${COST_EXPORT_FORMATS.join(" | ")}`));
          process.exit(1);
        }

        let result;
        try {
          result = await fetchCostExport({
            orgId,
            format: fmt as CostExportFormat,
            projectId: opts.project,
            start: opts.start,
            end: opts.end,
            currency: opts.currency,
            baseUrl: baseUrl(),
            apiKey: apiKey(),
          });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        // Stream-to-stdout when no --out, so the export can pipe straight into
        // a FinOps ingest tool (e.g. `evalguard cost-export <id> -f lago | curl ...`).
        if (!opts.out) {
          process.stdout.write(result.body);
          if (!result.body.endsWith("\n")) process.stdout.write("\n");
          return;
        }

        const outputPath = path.resolve(opts.out);
        fs.writeFileSync(outputPath, result.body, "utf-8");
        console.log();
        console.log(`  ${chalk.green("✓")} Wrote ${result.body.length} bytes to ${chalk.cyan(outputPath)}`);
        console.log(chalk.dim(`  Format: ${fmt}  •  ${result.contentType}`));
        console.log();
        if (fmt === "focus") {
          console.log(chalk.dim("  FOCUS 1.0 columnar CSV — ingest into your FinOps data lake (CUDOS / Cloudability / Apptio)."));
        } else if (fmt === "openmeter") {
          console.log(chalk.dim("  OpenMeter CloudEvents NDJSON — POST each line to the OpenMeter ingest API."));
        } else {
          console.log(chalk.dim("  Lago usage-event NDJSON — POST each line to the Lago events API."));
        }
        console.log();
      },
    );
}
