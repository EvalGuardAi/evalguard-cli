/**
 * `evalguard budget` — virtual-key spend cap management.
 *
 *   evalguard budget:get <key-id>
 *   evalguard budget:set <key-id> <usd-amount>
 *   evalguard budget:clear <key-id>
 *
 * Budgets are enforced server-side in the gateway proxy. When exceeded
 * the proxy returns 402 Payment Required with x-evalguard-budget-usd +
 * x-evalguard-spent-usd headers. The counter resets on the first gateway
 * request of each period — daily / weekly / monthly, per the key's
 * `resetPeriod` (default monthly), aligned to UTC boundaries.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";

type ResetPeriod = "daily" | "weekly" | "monthly";

interface BudgetView {
  keyId: string;
  name?: string;
  monthlyBudgetUsd: number | null;
  resetPeriod?: ResetPeriod;
  currentPeriodSpentUsd: number;
  currentPeriodStartedAt: string;
  remainingUsd: number | null;
  percentUsed: number | null;
  staleReset?: boolean;
}

function baseUrl(): string {
  return resolveBaseUrl();
}

function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(
      chalk.red(
        "No EvalGuard API key found. Run `evalguard login --key <key>` or set EVALGUARD_API_KEY.",
      ),
    );
    process.exit(1);
  }
  return k;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (body as { data: T }).data;
}

function renderView(v: BudgetView): void {
  const cap = v.monthlyBudgetUsd === null ? chalk.dim("unlimited") : `$${v.monthlyBudgetUsd.toFixed(2)}`;
  const spent = `$${v.currentPeriodSpentUsd.toFixed(4)}`;
  const remaining =
    v.remainingUsd === null ? chalk.dim("—") : `$${v.remainingUsd.toFixed(4)}`;
  const pctStr =
    v.percentUsed === null
      ? chalk.dim("—")
      : v.percentUsed >= 100
      ? chalk.red(`${v.percentUsed.toFixed(1)}%`)
      : v.percentUsed >= 80
      ? chalk.yellow(`${v.percentUsed.toFixed(1)}%`)
      : chalk.green(`${v.percentUsed.toFixed(1)}%`);

  console.log();
  console.log(`  ${chalk.bold(v.name ?? v.keyId)}`);
  console.log(`  ${chalk.dim("Key")}       ${v.keyId}`);
  console.log(`  ${chalk.dim("Cap")}       ${cap}`);
  console.log(`  ${chalk.dim("Cadence")}   ${v.resetPeriod ?? "monthly"}`);
  console.log(`  ${chalk.dim("Spent")}     ${spent}`);
  console.log(`  ${chalk.dim("Remaining")} ${remaining}`);
  console.log(`  ${chalk.dim("Usage")}     ${pctStr}`);
  console.log(`  ${chalk.dim("Period")}    ${v.currentPeriodStartedAt}`);
  if (v.staleReset) console.log(chalk.yellow("  (period rollover pending — counter resets on next gateway request)"));
  console.log();
}

export function registerBudget(program: Command): void {
  const budget = program
    .command("budget")
    .description("Manage virtual-key monthly spend caps");

  budget
    .command("get")
    .description("Show current spend + cap + percent-used for an API key")
    .argument("<keyId>", "API key UUID")
    .option("--json", "Output as JSON", false)
    .action(async (keyId: string, opts: { json?: boolean }) => {
      const v = await apiFetch<BudgetView>(`/api-keys/${keyId}/budget`);
      if (opts.json) {
        console.log(JSON.stringify(v, null, 2));
        return;
      }
      renderView(v);
    });

  budget
    .command("set")
    .description("Set the USD cap for an API key (optionally with a reset cadence)")
    .argument("<keyId>", "API key UUID")
    .argument("<usd>", "Cap in USD (e.g. 100.00). Use 0 to block all gateway traffic.")
    .option(
      "--reset-period <cadence>",
      "Reset cadence: daily | weekly | monthly (default monthly)",
    )
    .action(async (keyId: string, usd: string, opts: { resetPeriod?: string }) => {
      const n = parseFloat(usd);
      if (!Number.isFinite(n) || n < 0) {
        console.error(chalk.red("Amount must be a non-negative number (or 'clear' to remove cap)."));
        process.exit(1);
      }
      const payload: { monthlyBudgetUsd: number; resetPeriod?: ResetPeriod } = { monthlyBudgetUsd: n };
      if (opts.resetPeriod !== undefined) {
        if (!["daily", "weekly", "monthly"].includes(opts.resetPeriod)) {
          console.error(chalk.red("--reset-period must be one of: daily, weekly, monthly"));
          process.exit(1);
        }
        payload.resetPeriod = opts.resetPeriod as ResetPeriod;
      }
      const v = await apiFetch<BudgetView>(`/api-keys/${keyId}/budget`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const cadence = v.resetPeriod ?? "monthly";
      console.log(chalk.green(`✓ cap set to $${(v.monthlyBudgetUsd ?? 0).toFixed(2)} (${cadence} reset)`));
    });

  budget
    .command("period")
    .description("Set the spend-cap reset cadence for an API key (daily | weekly | monthly)")
    .argument("<keyId>", "API key UUID")
    .argument("<cadence>", "daily | weekly | monthly")
    .action(async (keyId: string, cadence: string) => {
      if (!["daily", "weekly", "monthly"].includes(cadence)) {
        console.error(chalk.red("Cadence must be one of: daily, weekly, monthly"));
        process.exit(1);
      }
      const v = await apiFetch<BudgetView>(`/api-keys/${keyId}/budget`, {
        method: "PATCH",
        body: JSON.stringify({ resetPeriod: cadence }),
      });
      console.log(chalk.green(`✓ reset cadence set to ${v.resetPeriod ?? cadence}`));
    });

  // ── Per-key governance limits (G4) ─────────────────────────────────
  // TPM / RPM / max-parallel rate limits + a model allow-list, enforced at the
  // gateway. PATCH /api/v1/api-keys/:keyId. Only the flags you pass change;
  // pass `0` to a numeric flag (or --clear-models) to remove that limit.
  budget
    .command("limits")
    .description("Set per-key rate limits (TPM/RPM/max-parallel) and a model allow-list")
    .argument("<keyId>", "API key UUID")
    .option("--tpm <n>", "Tokens/minute ceiling (0 to clear)")
    .option("--rpm <n>", "Requests/minute ceiling (0 to clear)")
    .option("--max-parallel <n>", "Max concurrent in-flight requests (0 to clear)")
    .option(
      "--models <list>",
      "Comma-separated model allow-list (gateway 403s any other model)",
    )
    .option("--clear-models", "Remove the model allow-list (allow all models)", false)
    .action(
      async (
        keyId: string,
        opts: {
          tpm?: string;
          rpm?: string;
          maxParallel?: string;
          models?: string;
          clearModels?: boolean;
        },
      ) => {
        // Translate a numeric flag → number | null (0 clears). Reject non-numeric.
        const num = (raw: string | undefined, label: string): number | null | undefined => {
          if (raw === undefined) return undefined; // leave untouched
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
            console.error(chalk.red(`${label} must be a non-negative whole number (0 to clear).`));
            process.exit(1);
          }
          return n === 0 ? null : n;
        };

        const payload: Record<string, unknown> = {};
        const tpm = num(opts.tpm, "--tpm");
        const rpm = num(opts.rpm, "--rpm");
        const maxParallel = num(opts.maxParallel, "--max-parallel");
        if (tpm !== undefined) payload.tpmLimit = tpm;
        if (rpm !== undefined) payload.rpmLimit = rpm;
        if (maxParallel !== undefined) payload.maxParallel = maxParallel;
        if (opts.clearModels) {
          payload.modelAllowlist = [];
        } else if (opts.models !== undefined) {
          payload.modelAllowlist = opts.models
            .split(",")
            .map((m) => m.trim())
            .filter((m) => m.length > 0);
        }

        if (Object.keys(payload).length === 0) {
          console.error(
            chalk.red(
              "Nothing to update. Pass at least one of --tpm, --rpm, --max-parallel, --models, --clear-models.",
            ),
          );
          process.exit(1);
        }

        const v = await apiFetch<{
          id: string;
          name: string;
          tpmLimit: number | null;
          rpmLimit: number | null;
          maxParallel: number | null;
          modelAllowlist: string[] | null;
        }>(`/api-keys/${keyId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });

        console.log(chalk.green(`✓ updated limits for ${v.name}`));
        const fmt = (n: number | null) => (n === null ? chalk.dim("unlimited") : String(n));
        console.log(`  ${chalk.dim("TPM")}           ${fmt(v.tpmLimit)}`);
        console.log(`  ${chalk.dim("RPM")}           ${fmt(v.rpmLimit)}`);
        console.log(`  ${chalk.dim("Max parallel")}  ${fmt(v.maxParallel)}`);
        console.log(
          `  ${chalk.dim("Models")}        ${
            v.modelAllowlist && v.modelAllowlist.length > 0
              ? v.modelAllowlist.join(", ")
              : chalk.dim("all allowed")
          }`,
        );
      },
    );

  budget
    .command("clear")
    .description("Remove the monthly cap (unlimited spend on this key)")
    .argument("<keyId>", "API key UUID")
    .option("--dry-run", "Show the current cap that would be removed without changing it", false)
    .action(async (keyId: string, opts: { dryRun?: boolean }) => {
      // E2 (2026-05-19): removing a spend cap is destructive — the key
      // becomes uncapped and a buggy or compromised caller could burn
      // through any amount before someone notices. --dry-run lets ops
      // verify the current cap before tearing it down.
      if (opts.dryRun) {
        const current = await apiFetch<BudgetView>(`/api-keys/${keyId}/budget`);
        const cap = current.monthlyBudgetUsd === null
          ? chalk.dim("already unlimited")
          : `$${current.monthlyBudgetUsd.toFixed(2)}`;
        console.log();
        console.log(chalk.dim("  [dry-run]") + " The following cap WOULD be removed:");
        console.log(`  ${chalk.dim("Key")}   ${keyId}`);
        console.log(`  ${chalk.dim("Cap")}   ${cap}`);
        console.log(`  ${chalk.dim("Spent")} $${current.currentPeriodSpentUsd.toFixed(4)} this period`);
        console.log(chalk.dim("  No changes written."));
        console.log();
        return;
      }
      await apiFetch<BudgetView>(`/api-keys/${keyId}/budget`, { method: "DELETE" });
      console.log(chalk.green(`✓ cap removed — ${keyId} is now unlimited`));
    });
}
