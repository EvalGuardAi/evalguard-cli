/**
 * `evalguard shadow-ai` — shadow-AI discovery (Gap #2).
 *
 *   evalguard shadow-ai:upload <ndjson-file> --source <zscaler|netskope|cloudflare|okta|generic>
 *   evalguard shadow-ai:policy:list
 *   evalguard shadow-ai:policy:set <domain> --status <approved|blocked|pending> [--rationale <text>]
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";

function baseUrl(): string { return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1"; }
function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) { console.error(chalk.red("EVALGUARD_API_KEY not set.")); process.exit(1); }
  return k;
}
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export function registerShadowAI(program: Command): void {
  const cmd = program.command("shadow-ai").description("Shadow-AI discovery — ingest SSO/firewall/CASB logs, classify AI-SaaS usage");

  cmd
    .command("upload <ndjsonFile>")
    .description("Upload egress log rows (NDJSON, one object per line) for classification")
    .requiredOption("--source <source>", "zscaler | netskope | cloudflare | okta | generic")
    .option("--chunk-size <n>", "Rows per API call (max 10000)", "5000")
    .action(async (filePath: string, opts: { source: string; chunkSize: string }) => {
      if (!fs.existsSync(filePath)) { console.error(chalk.red(`File not found: ${filePath}`)); process.exit(1); }
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
      const chunkSize = Math.min(Number(opts.chunkSize) || 5000, 10000);
      const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      console.log(chalk.dim(`Parsed ${rows.length} rows from ${filePath}; uploading in chunks of ${chunkSize}...`));
      let ingested = 0, newCount = 0, updatedCount = 0, skipped = 0;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const body = (await apiFetch(`/shadow-ai/ingest`, {
          method: "POST",
          body: JSON.stringify({ source: opts.source, rows: chunk }),
        })) as { success: boolean; data: { ingested: number; newSightings: number; updatedSightings: number; skipped: number } };
        ingested += body.data.ingested;
        newCount += body.data.newSightings;
        updatedCount += body.data.updatedSightings;
        skipped += body.data.skipped;
      }
      console.log(chalk.green(`✓ ${ingested} sightings ingested (${newCount} new, ${updatedCount} updated), ${skipped} skipped`));
    });

  cmd
    .command("detections")
    .description("List detected AI tools (rolled up from sightings), ranked by request volume")
    .requiredOption("--project <projectId>", "Project ID")
    .option("--category <c>", "Filter: approved | restricted | blocked | unclassified")
    .option("--risk <r>", "Minimum data risk: none | low | medium | high | critical")
    .option("--json", "Emit JSON")
    .action(async (opts: { project: string; category?: string; risk?: string; json?: boolean }) => {
      const qs = new URLSearchParams({ projectId: opts.project });
      if (opts.category) qs.set("category", opts.category);
      if (opts.risk) qs.set("risk", opts.risk);
      const body = (await apiFetch(`/shadow-ai/detections?${qs.toString()}`)) as {
        data: { detections: Array<Record<string, unknown>>; summary: Record<string, number> };
      };
      if (opts.json) { console.log(JSON.stringify(body.data, null, 2)); return; }
      const { detections, summary } = body.data;
      console.log(chalk.bold(`\n${summary.totalTools} AI tools detected — ${chalk.red(String(summary.unsanctionedTools))} unsanctioned, ${summary.highRiskTools} high-risk, ${summary.totalUsers} users\n`));
      for (const d of detections) {
        const flag = d.unsanctioned ? chalk.red("⚠ unsanctioned") : chalk.dim(String(d.policyStatus));
        console.log(`${chalk.cyan(String(d.toolName).padEnd(22))} ${String(d.dataRisk).padEnd(8)} users=${String(d.userCount).padEnd(5)} reqs=${String(d.requestCount).padEnd(8)} ${flag}`);
      }
    });

  const policy = cmd.command("policy").description("Per-domain policy overrides (approved | blocked | pending)");

  policy
    .command("list")
    .requiredOption("--project <projectId>", "Project ID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; json?: boolean }) => {
      const body = (await apiFetch(`/shadow-ai/policy?projectId=${encodeURIComponent(opts.project)}`)) as {
        success: boolean;
        data: { policies: Array<{ domain: string; status: string; rationale: string | null; updated_at: string }>; total: number };
      };
      if (opts.json) { console.log(JSON.stringify(body.data.policies, null, 2)); return; }
      if (body.data.total === 0) { console.log(chalk.dim("No policies set.")); return; }
      console.log(chalk.bold("\nDomain                          Status     Updated      Rationale"));
      for (const p of body.data.policies) {
        console.log(`  ${p.domain.padEnd(30)} ${p.status.padEnd(10)} ${p.updated_at.slice(0, 10)}  ${p.rationale ?? ""}`);
      }
    });

  policy
    .command("set <domain>")
    .requiredOption("--status <status>", "approved | blocked | pending")
    .option("--rationale <text>", "Why this status")
    .requiredOption("--project <projectId>", "Project ID")
    .action(async (domain: string, opts: { status: string; rationale?: string; project: string }) => {
      await apiFetch(`/shadow-ai/policy`, {
        method: "POST",
        body: JSON.stringify({ domain, status: opts.status, rationale: opts.rationale, projectId: opts.project }),
      });
      console.log(chalk.green(`✓ Policy set: ${domain} → ${opts.status}`));
    });
}
