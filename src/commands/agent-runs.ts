/**
 * `evalguard agent-runs` — per-agent-run metered billing (Gap #5).
 *
 *   evalguard agent-runs:list [--since <iso>] [--group-by <agent_tag|end_customer_id|api_key_id>] [--json]
 *   evalguard agent-runs:start [--end-customer <id>] [--json]
 *   evalguard agent-runs:end <runId> --cost <usd> [--tokens-in <n>] [--tokens-out <n>]
 */
import { Command } from "commander";
import chalk from "chalk";

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}
function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) { console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`.")); process.exit(1); }
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

export function registerAgentRuns(program: Command): void {
  const cmd = program.command("agent-runs").description("Per-agent-run metered billing (chargeback + budget caps)");

  cmd
    .command("list")
    .description("List agent runs, optionally grouped by tag/customer/key")
    .option("--since <iso>", "Lower bound on started_at (default: 30 days ago)")
    .option("--group-by <field>", "agent_tag | end_customer_id | api_key_id")
    .option("--limit <n>", "Max rows", "100")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { since?: string; groupBy?: string; limit?: string; json?: boolean }) => {
      const qs = new URLSearchParams();
      if (opts.since) qs.set("since", opts.since);
      if (opts.groupBy) qs.set("groupBy", opts.groupBy);
      if (opts.limit) qs.set("limit", opts.limit);
      const body = (await apiFetch(`/agent-runs${qs.toString() ? `?${qs}` : ""}`)) as {
        success: boolean;
        data: { runs?: Record<string, unknown>[]; groups?: Record<string, unknown>[]; total: number; since: string };
      };
      if (opts.json) { console.log(JSON.stringify(body.data, null, 2)); return; }
      if (body.data.groups) {
        console.log(chalk.bold(`\nAgent runs (grouped by ${opts.groupBy}), since ${body.data.since}\n`));
        for (const g of body.data.groups) {
          console.log(`  ${String(g[opts.groupBy!] ?? "—").padEnd(30)} $${Number(g.totalCostUsd).toFixed(4)}  ${g.runCount} runs`);
        }
      } else {
        console.log(chalk.bold(`\nAgent runs (${body.data.total} total), since ${body.data.since}\n`));
        for (const r of body.data.runs ?? []) {
          console.log(`  ${String(r.id).slice(0, 8)}  ${r.status}  $${Number(r.cost_usd).toFixed(4)}  ${r.agent_tag ?? "—"}  ${r.end_customer_id ?? ""}`);
        }
      }
    });

  cmd
    .command("start")
    .description("Open a new metered agent run")
    .option("--end-customer <id>", "End-customer identifier for chargeback")
    .option("--trace-id <id>", "OTel trace id to link")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { endCustomer?: string; traceId?: string; json?: boolean }) => {
      const body = (await apiFetch(`/agent-runs/start`, {
        method: "POST",
        body: JSON.stringify({ endCustomerId: opts.endCustomer, traceId: opts.traceId }),
      })) as { success: boolean; data: { runId: string; status: string; startedAt: string } };
      if (opts.json) { console.log(JSON.stringify(body.data, null, 2)); return; }
      console.log(chalk.green(`✓ Run started: ${body.data.runId}`));
      console.log(chalk.dim(`  Pass x-evalguard-run-id: ${body.data.runId} to gateway requests to meter them.`));
    });

  cmd
    .command("end <runId>")
    .description("Close an agent run (idempotent)")
    .requiredOption("--cost <usd>", "Additional cost to add beyond what the gateway accumulated")
    .option("--tokens-in <n>", "Additional tokens-in to add", "0")
    .option("--tokens-out <n>", "Additional tokens-out to add", "0")
    .option("--status <s>", "completed | failed | budget_exceeded", "completed")
    .action(async (runId: string, opts: { cost: string; tokensIn: string; tokensOut: string; status: string }) => {
      const body = (await apiFetch(`/agent-runs/${encodeURIComponent(runId)}/end`, {
        method: "POST",
        body: JSON.stringify({
          costUsd: Number(opts.cost),
          tokensIn: Number(opts.tokensIn),
          tokensOut: Number(opts.tokensOut),
          status: opts.status,
        }),
      })) as { success: boolean; data: { runId: string; costUsd: number; status: string } };
      console.log(chalk.green(`✓ Run ${body.data.runId} closed: status=${body.data.status} cost=$${body.data.costUsd.toFixed(4)}`));
    });
}
