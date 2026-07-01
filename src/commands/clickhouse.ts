/**
 * `evalguard clickhouse` — verify the org's ClickHouse OLAP connection.
 *
 *   evalguard clickhouse status [--json]
 *
 * Reads the org's clickhouse_config row + runs a fast SELECT 1 probe
 * through the @evalguard/core HTTP client. Surfaces latency + health
 * status + last error so operators can rule out the OLAP layer quickly.
 */
import { Command } from "commander";
import chalk from "chalk";

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}
function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return k;
}
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

interface StatusResponse {
  configured: boolean;
  enabled?: boolean;
  hostUrl?: string;
  databaseName?: string;
  healthStatus?: "healthy" | "degraded" | "unreachable" | null;
  lastHealthCheckAt?: string | null;
  lastError?: string | null;
  liveProbe?: { ok: boolean; latencyMs: number; error?: string };
}

export function registerClickhouse(program: Command): void {
  const cmd = program.command("clickhouse").description("Manage the Phase 5b ClickHouse OLAP layer");

  cmd
    .command("status")
    .description("Verify the configured ClickHouse cluster is reachable + auth works")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const body = (await apiFetch("/admin/clickhouse/status")) as { data: StatusResponse };
      const s = body.data;
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log();
      if (!s.configured) {
        console.log(chalk.dim("  No ClickHouse cluster configured for this org."));
        console.log(chalk.dim("  See /docs/clickhouse for the opt-in dual-write setup."));
        console.log();
        return;
      }
      const tone =
        s.liveProbe?.ok === true
          ? chalk.green
          : s.liveProbe?.ok === false
            ? chalk.red
            : s.healthStatus === "healthy"
              ? chalk.green
              : s.healthStatus === "degraded"
                ? chalk.yellow
                : chalk.red;
      console.log(`  ${chalk.dim("Status:    ")} ${tone(s.healthStatus ?? "unknown")}`);
      if (s.liveProbe) {
        console.log(`  ${chalk.dim("Latency:   ")} ${s.liveProbe.latencyMs}ms ${s.liveProbe.ok ? chalk.green("(probe OK)") : chalk.red("(probe FAILED)")}`);
      }
      console.log(`  ${chalk.dim("Host:      ")} ${s.hostUrl}`);
      console.log(`  ${chalk.dim("Database:  ")} ${s.databaseName}`);
      console.log(`  ${chalk.dim("Enabled:   ")} ${s.enabled ? chalk.green("yes") : chalk.dim("no")}`);
      if (s.lastHealthCheckAt) {
        console.log(`  ${chalk.dim("Last check:")} ${new Date(s.lastHealthCheckAt).toLocaleString()}`);
      }
      if (s.lastError) {
        console.log(`  ${chalk.dim("Last error:")} ${chalk.red(s.lastError)}`);
      }
      if (s.liveProbe?.error) {
        console.log(`  ${chalk.dim("Probe err: ")} ${chalk.red(s.liveProbe.error)}`);
      }
      console.log();
    });
}
