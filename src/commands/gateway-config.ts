/**
 * `evalguard gateway-config get|set` — read / write the LLM gateway routing
 * configuration.
 *
 * Surfaces the gateway config route (GET + PUT /api/v1/gateway) on the
 * terminal. The gateway is EvalGuard's multi-provider LLM router; this command
 * lets an org admin inspect and update the per-org routing knobs that the
 * hosted proxy enforces (when EVALGUARD_GATEWAY_ROUTER=true), including the
 * REAL learned-routing strategies (thompson / quality-cost) — not just
 * round-robin / weighted:
 *
 *   evalguard gateway-config get
 *   evalguard gateway-config set --org <orgId> --strategy thompson
 *   evalguard gateway-config set --org <orgId> --strategy least-cost --disable-cache --enable
 *
 * Provider API keys are NEVER sent or stored by this command — keys resolve
 * from your stored Provider Keys (Vault) at request time. The server is
 * canonical; the CLI is a thin client over its config endpoints.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Kept in lock-step with the PUT route's routingStrategy enum + the core
// RoutingStrategy union (incl. the learned-routing strategies).
export const ROUTING_STRATEGIES = [
  "priority",
  "round-robin",
  "weighted",
  "least-latency",
  "least-cost",
  "least-load",
  "random",
  "quality-cost",
  "thompson",
] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

// Canonical precedence: env > ~/.evalguard/config.json > default. Previously
// these read only process.env, so `evalguard login` config-file auth was ignored.
function baseUrl(): string {
  return resolveBaseUrl();
}

function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(
      chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login` first or export the key."),
    );
    process.exit(1);
  }
  return k;
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string; code?: string };
  };
  if (!res.ok) {
    throw new Error(
      `${label} failed: HTTP ${res.status} (${json.error?.code ?? "ERROR"}: ${json.error?.message ?? "unknown"})`,
    );
  }
  return (json.data ?? (json as unknown as T)) as T;
}

export interface GatewayConfigView {
  id?: string;
  providers?: Array<{ name: string; enabled?: boolean; models?: string[]; weight?: number; priority?: number; health?: string; circuitState?: string }>;
  routing?: { strategy?: string; availableStrategies?: string[] };
  cache?: { enabled?: boolean; ttlSec?: number; keyStrategy?: string };
  rateLimiting?: { enabled?: boolean; requestsPerMinute?: number; tokensPerMinute?: number };
  status?: { uptimeMs?: number; totalRequests?: number; activeProviders?: number };
}

/** GET the current gateway config + status. Pure + testable. */
export async function fetchGatewayConfig(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayConfigView> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/gateway`, {
    method: "GET",
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  return unwrap<GatewayConfigView>(res, "Gateway config get");
}

export interface GatewayConfigUpdate {
  orgId: string;
  routingStrategy?: RoutingStrategy;
  enabled?: boolean;
  cacheEnabled?: boolean;
  cacheTtlSec?: number;
}

export interface GatewayConfigSetResult {
  orgId: string;
  routingStrategy: string;
  enabled: boolean;
  cacheEnabled: boolean;
  cacheTtlSec: number;
  providers?: unknown;
  note?: string;
}

/** PUT the per-org routing config. Pure + testable. */
export async function setGatewayConfig(opts: {
  update: GatewayConfigUpdate;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayConfigSetResult> {
  const u = opts.update;
  if (!UUID_RE.test(u.orgId)) {
    throw new Error(`orgId must be a valid UUID. Got: ${u.orgId}`);
  }
  if (u.routingStrategy && !(ROUTING_STRATEGIES as readonly string[]).includes(u.routingStrategy)) {
    throw new Error(`strategy must be one of: ${ROUTING_STRATEGIES.join(", ")}`);
  }
  // Require at least one knob beyond orgId so a `set` with no changes is a
  // clear client-side error rather than a silent no-op round-trip.
  if (
    u.routingStrategy === undefined &&
    u.enabled === undefined &&
    u.cacheEnabled === undefined &&
    u.cacheTtlSec === undefined
  ) {
    throw new Error("Nothing to set — pass at least one of --strategy / --enable / --disable / --enable-cache / --disable-cache / --cache-ttl");
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/gateway`, {
    method: "PUT",
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(u),
  });
  return unwrap<GatewayConfigSetResult>(res, "Gateway config set");
}

export function registerGatewayConfig(program: Command): void {
  const cmd = program
    .command("gateway-config")
    .description("Read / write the LLM gateway routing configuration (strategy, cache, providers)");

  cmd
    .command("get")
    .description("Show the current gateway routing config + provider health/status")
    .option("--json", "Output the full config as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      let config: GatewayConfigView;
      try {
        config = await fetchGatewayConfig({ baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — gateway routing config"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Strategy:  ${chalk.bold(config.routing?.strategy ?? "priority")}`);
      if (config.routing?.availableStrategies?.length) {
        console.log(chalk.dim(`             available: ${config.routing.availableStrategies.join(", ")}`));
      }
      console.log(`  Cache:     ${config.cache?.enabled ? chalk.green("on") : chalk.dim("off")} ${chalk.dim(`(ttl ${config.cache?.ttlSec ?? 0}s, ${config.cache?.keyStrategy ?? "exact"})`)}`);
      console.log(
        `  Rate cap:  ${config.rateLimiting?.enabled ? chalk.green("on") : chalk.dim("off")} ` +
          chalk.dim(`(${config.rateLimiting?.requestsPerMinute ?? 0} req/min, ${config.rateLimiting?.tokensPerMinute ?? 0} tok/min)`),
      );
      console.log();
      const providers = config.providers ?? [];
      if (providers.length > 0) {
        console.log(chalk.bold("  Providers:"));
        for (const p of providers) {
          const en = p.enabled === false ? chalk.dim("disabled") : chalk.green("enabled");
          console.log(`    • ${chalk.cyan(p.name.padEnd(12))} ${en}  ${chalk.dim(`health=${p.health ?? "?"} circuit=${p.circuitState ?? "?"}`)}`);
        }
        console.log();
      }
      if (config.status) {
        console.log(chalk.dim(`  ${config.status.totalRequests ?? 0} requests • ${config.status.activeProviders ?? 0} active providers`));
        console.log();
      }
    });

  cmd
    .command("set")
    .description("Update the per-org gateway routing config (admin only)")
    .requiredOption("--org <orgId>", "Org UUID to update")
    .option("-s, --strategy <strategy>", `Routing strategy: ${ROUTING_STRATEGIES.join(" | ")}`)
    .option("--enable", "Enable the gateway for this org")
    .option("--disable", "Disable the gateway for this org")
    .option("--enable-cache", "Enable response caching")
    .option("--disable-cache", "Disable response caching")
    .option("--cache-ttl <seconds>", "Cache TTL in seconds", (v) => parseInt(v, 10))
    .option("--json", "Output the server result as JSON", false)
    .action(
      async (opts: {
        org: string;
        strategy?: string;
        enable?: boolean;
        disable?: boolean;
        enableCache?: boolean;
        disableCache?: boolean;
        cacheTtl?: number;
        json?: boolean;
      }) => {
        if (opts.enable && opts.disable) {
          console.error(chalk.red("  Pass only one of --enable / --disable."));
          process.exit(1);
        }
        if (opts.enableCache && opts.disableCache) {
          console.error(chalk.red("  Pass only one of --enable-cache / --disable-cache."));
          process.exit(1);
        }
        if (opts.strategy && !(ROUTING_STRATEGIES as readonly string[]).includes(opts.strategy)) {
          console.error(chalk.red(`  Unknown strategy: ${opts.strategy}. Choose: ${ROUTING_STRATEGIES.join(" | ")}`));
          process.exit(1);
        }

        const update: GatewayConfigUpdate = { orgId: opts.org };
        if (opts.strategy) update.routingStrategy = opts.strategy as RoutingStrategy;
        if (opts.enable) update.enabled = true;
        if (opts.disable) update.enabled = false;
        if (opts.enableCache) update.cacheEnabled = true;
        if (opts.disableCache) update.cacheEnabled = false;
        if (opts.cacheTtl !== undefined) update.cacheTtlSec = opts.cacheTtl;

        let result: GatewayConfigSetResult;
        try {
          result = await setGatewayConfig({ update, baseUrl: baseUrl(), apiKey: apiKey() });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log();
        console.log(`  ${chalk.green("✓")} Gateway routing config updated for org ${chalk.cyan(result.orgId)}`);
        console.log(`    Strategy: ${chalk.bold(result.routingStrategy)}  •  enabled: ${result.enabled}  •  cache: ${result.cacheEnabled} (ttl ${result.cacheTtlSec}s)`);
        if (result.note) {
          console.log();
          console.log(chalk.dim(`  ${result.note}`));
        }
        console.log();
      },
    );
}
