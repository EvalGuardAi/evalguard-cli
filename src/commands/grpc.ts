/**
 * `evalguard grpc` — quick-poke commands for the Connect-RPC gateway
 * that landed in 8a7f046d. Uses the JSON transport so it works
 * everywhere without a Connect-RPC client dependency.
 *
 *   evalguard grpc health [--json]                    — GatewayService.Health
 *   evalguard grpc models [--provider <id>] [--json]  — GatewayService.ListModels
 */
import { Command } from "commander";
import chalk from "chalk";

function baseUrl(): string {
  // Default to the prod gRPC root — strip the trailing /v1 if present
  // since gRPC routes live at /api/grpc, not /api/v1/grpc.
  const base = process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
  return base.replace(/\/v1\/?$/, "");
}
function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return k;
}

async function connectCall(method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const url = `${baseUrl()}/grpc/evalguard.gateway.v1.GatewayService/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const errBody = parsed as { code?: string; message?: string } | null;
    throw new Error(`${errBody?.code ?? `HTTP ${res.status}`}: ${errBody?.message ?? "unknown"}`);
  }
  return parsed;
}

interface HealthResponse {
  status: string;
  components: Record<string, string>;
  timestamp: string;
}

interface ListModelsResponse {
  models: Array<{ id: string; provider: string; display_name: string }>;
}

export function registerGrpc(program: Command): void {
  const cmd = program.command("grpc").description("Hit the Connect-RPC gateway endpoints from the command line");

  cmd
    .command("health")
    .description("Probe GatewayService.Health (db + redis + queue probe)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const body = (await connectCall("Health")) as HealthResponse;
      if (opts.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      const statusColor =
        body.status === "healthy" ? chalk.green : body.status === "degraded" ? chalk.yellow : chalk.red;
      console.log();
      console.log(`  Status:    ${statusColor(body.status)}`);
      console.log(`  Timestamp: ${chalk.dim(body.timestamp)}`);
      console.log();
      console.log(chalk.bold("  Components"));
      for (const [name, state] of Object.entries(body.components)) {
        const color = state === "healthy" || state === "ok" ? chalk.green : chalk.red;
        console.log(`    ${chalk.cyan(name.padEnd(20))} ${color(state)}`);
      }
      console.log();
    });

  cmd
    .command("models")
    .description("List the model catalog from GatewayService.ListModels")
    .option("--provider <id>", "Filter to one provider (openai, anthropic, ...)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const body = (await connectCall("ListModels", opts.provider ? { provider: opts.provider } : {})) as ListModelsResponse;
      if (opts.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  ${body.models.length} models${opts.provider ? ` (filtered to ${opts.provider})` : ""}`));
      console.log();
      // Group by provider for a cleaner read.
      const byProvider = new Map<string, string[]>();
      for (const m of body.models) {
        if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
        byProvider.get(m.provider)!.push(m.id);
      }
      for (const [provider, ids] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`  ${chalk.bold(provider)}  ${chalk.dim(`(${ids.length})`)}`);
        for (const id of ids) {
          console.log(`    ${chalk.cyan(id)}`);
        }
        console.log();
      }
    });
}
