/**
 * `evalguard mcp` — wraps the MCP registry + preset API surface so the
 * Quick-add picker that landed in 382d091e has CLI parity.
 *
 *   evalguard mcp presets [--json]                — list vendor presets
 *   evalguard mcp preset <id> [--json]            — fetch a single preset
 *   evalguard mcp servers [--json]                — list registered servers
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";

// Canonical precedence: env > ~/.evalguard/config.json > default. Previously
// these read only process.env, so `evalguard login` config-file auth was ignored
// (inconsistent with the rest of the CLI).
function baseUrl(): string {
  return resolveBaseUrl();
}
function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard login` or `evalguard init`."));
    process.exit(1);
  }
  return k;
}
async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
    },
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

interface PresetPermission {
  toolName: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  allowedRoles: string[];
}

interface PresetRow {
  id: string;
  vendor: string;
  description: string;
  url: string;
  transport: string;
  authType: string;
  authHint: string;
  tags: string[];
  defaultPermissions: PresetPermission[];
  setupGuide: string;
  docsUrl: string;
  hosting: string;
}

interface ServerRow {
  id: string;
  name: string;
  url: string;
  transport: string;
  authType: string;
  enabled: boolean;
  healthStatus: string | null;
  tags: string[];
}

interface McpAuditFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  target: string;
  title: string;
  remediation: string;
}
interface McpAuditReport {
  verdict: "block" | "review" | "pass";
  riskScore: number;
  toolCount: number;
  summary: { critical: number; high: number; medium: number; low: number; total: number };
  findings: McpAuditFinding[];
}

function printAuditReport(r: McpAuditReport): void {
  const verdictColor = r.verdict === "block" ? chalk.red : r.verdict === "review" ? chalk.yellow : chalk.green;
  console.log();
  console.log(`  ${verdictColor(r.verdict.toUpperCase())}  risk ${r.riskScore}/100  ·  ${r.summary.total} finding(s) over ${r.toolCount} tool(s)`);
  console.log(`  ${chalk.dim(`critical ${r.summary.critical} · high ${r.summary.high} · medium ${r.summary.medium} · low ${r.summary.low}`)}`);
  console.log();
  for (const f of r.findings) {
    const sev = f.severity === "critical" || f.severity === "high" ? chalk.red(f.severity) : f.severity === "medium" ? chalk.yellow(f.severity) : chalk.dim(f.severity);
    console.log(`  ${sev.padEnd(18)} ${chalk.dim(f.target)}  ${f.title}`);
    console.log(`  ${" ".repeat(10)} ${chalk.dim("fix:")} ${f.remediation}`);
  }
  console.log();
}

export function registerMcp(program: Command): void {
  const cmd = program.command("mcp").description("Interact with the MCP gateway (presets + registry)");

  cmd
    .command("presets")
    .description("List vendor presets available for the Quick-add picker")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const body = (await apiFetch("/mcp/presets")) as { data: { presets: PresetRow[] } };
      const presets = body.data.presets;
      if (opts.json) {
        console.log(JSON.stringify(presets, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  MCP vendor presets (${presets.length})`));
      console.log();
      for (const p of presets) {
        const hostingTag =
          p.hosting === "official-remote"
            ? chalk.green("official")
            : chalk.blue("community");
        console.log(`  ${chalk.cyan(p.id.padEnd(12))} ${hostingTag.padEnd(18)} ${chalk.dim(p.transport.padEnd(8))} ${chalk.dim(p.authType.padEnd(8))} ${p.vendor}`);
        console.log(`  ${" ".repeat(12)} ${chalk.dim(p.description)}`);
      }
      console.log();
      console.log(chalk.dim("  Use `evalguard mcp preset <id>` for full setup guide + tool ACLs."));
      console.log();
    });

  cmd
    .command("preset <id>")
    .description("Show full details for a single preset (setup guide + default tool ACLs)")
    .option("--json", "Output as JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const body = (await apiFetch(`/mcp/presets?id=${encodeURIComponent(id)}`)) as { data: { preset: PresetRow } };
      const p = body.data.preset;
      if (opts.json) {
        console.log(JSON.stringify(p, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  ${p.vendor}  ${chalk.dim(`(${p.id})`)}`));
      console.log(`  ${chalk.dim(p.description)}`);
      console.log();
      console.log(`  ${chalk.dim("URL:       ")} ${p.url}`);
      console.log(`  ${chalk.dim("Transport: ")} ${p.transport}`);
      console.log(`  ${chalk.dim("Auth:      ")} ${p.authType} — ${p.authHint}`);
      console.log(`  ${chalk.dim("Hosting:   ")} ${p.hosting}`);
      console.log(`  ${chalk.dim("Tags:      ")} ${p.tags.join(", ")}`);
      console.log(`  ${chalk.dim("Docs:      ")} ${p.docsUrl}`);
      console.log();
      console.log(chalk.bold("  Setup guide"));
      for (const line of p.setupGuide.split("\n")) {
        console.log(`  ${chalk.dim(line || " ")}`);
      }
      console.log();
      console.log(chalk.bold(`  Default tool ACLs (${p.defaultPermissions.length})`));
      for (const perm of p.defaultPermissions) {
        const riskColor =
          perm.riskLevel === "critical"
            ? chalk.red
            : perm.riskLevel === "high"
              ? chalk.yellow
              : perm.riskLevel === "medium"
                ? chalk.cyan
                : chalk.dim;
        const allowed = perm.allowedRoles.length === 0 ? chalk.red("denied") : perm.allowedRoles.join(",");
        console.log(`  ${chalk.cyan(perm.toolName.padEnd(28))} ${riskColor(perm.riskLevel.padEnd(10))} ${allowed}`);
      }
      console.log();
    });

  cmd
    .command("servers")
    .description("List MCP servers registered to your org")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const body = (await apiFetch("/mcp/servers")) as { data: { servers: ServerRow[] } };
      const servers = body.data.servers;
      if (opts.json) {
        console.log(JSON.stringify(servers, null, 2));
        return;
      }
      console.log();
      if (servers.length === 0) {
        console.log(chalk.dim("  No MCP servers registered yet. Add one from the dashboard:"));
        console.log(chalk.dim("    /dashboard/mcp/registry"));
        console.log();
        return;
      }
      console.log(chalk.bold(`  MCP servers (${servers.length})`));
      console.log();
      for (const s of servers) {
        const status = !s.enabled
          ? chalk.dim("disabled")
          : s.healthStatus === "healthy"
            ? chalk.green("healthy")
            : s.healthStatus === "degraded"
              ? chalk.yellow("degraded")
              : s.healthStatus === "unreachable"
                ? chalk.red("unreachable")
                : chalk.dim("unknown");
        console.log(`  ${chalk.cyan(s.name.padEnd(28))} ${status.padEnd(20)} ${chalk.dim(s.transport.padEnd(8))} ${chalk.dim(s.authType.padEnd(8))}`);
        console.log(`  ${" ".repeat(28)} ${chalk.dim(s.url)}`);
      }
      console.log();
    });

  // ─── mcp audit — pre-deploy security audit (CI gate) ────────────────
  cmd
    .command("audit")
    .description("Pre-deploy security audit of an MCP server config (CI gate)")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--file <path>", "JSON file: { server, tools }")
    .option("--fail-on <verdict>", "Exit non-zero when the verdict is this or worse: block | review", "block")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; file: string; failOn: string; json?: boolean }) => {
      try {
        const fs = await import("node:fs");
        const cfg = JSON.parse(fs.readFileSync(opts.file, "utf8")) as { server?: unknown; tools?: unknown };
        const res = await fetch(`${baseUrl()}/security/mcp-predeployment-audit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
          body: JSON.stringify({ projectId: opts.project, server: cfg.server ?? {}, tools: cfg.tools ?? [] }),
        });
        const body = (await res.json().catch(() => null)) as { data?: McpAuditReport; error?: { message?: string } } | null;
        if (!res.ok || !body?.data) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        const report = body.data;
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else printAuditReport(report);
        // CI gate: exit non-zero when the verdict meets the --fail-on threshold.
        const order = ["pass", "review", "block"];
        const threshold = opts.failOn === "review" ? order.indexOf("review") : order.indexOf("block");
        if (order.indexOf(report.verdict) >= threshold) process.exit(1);
      } catch (e) {
        console.error(chalk.red(`mcp audit failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
