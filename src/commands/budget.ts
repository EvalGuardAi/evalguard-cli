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
import { boundedFetch, decodeJsonBody, expectResult } from "../lib/http.js";
import { parseUuidArg } from "../lib/arg-validate.js";

/** Every budget subcommand takes the same positional, so it gets the same check. */
const KEY_ID_CONSEQUENCE =
  "The id is interpolated straight into `/api-keys/<id>/budget`, so the request would have gone " +
  "out and come back 404 — and `budget set` / `budget clear` are WRITES.";

const keyIdArg = (raw: string): string => parseUuidArg(raw, "API key id", KEY_ID_CONSEQUENCE);

type ResetPeriod = "daily" | "weekly" | "monthly";

/**
 * The budget view as the ROUTE actually sends it.
 *
 * `remainingUsd` / `percentUsed` / `currentPeriodStartedAt` / `keyId` were all
 * declared non-optional here, which is why `tsc` was perfectly happy with
 * `v.remainingUsd.toFixed(4)` and the TypeError only showed up at runtime. They
 * are derived / conditional columns; typing them as optional is what makes the
 * compiler enforce the null-guards rather than the reviewer.
 */
interface BudgetView {
  keyId?: string;
  name?: string;
  monthlyBudgetUsd: number | null;
  resetPeriod?: ResetPeriod;
  currentPeriodSpentUsd: number;
  currentPeriodStartedAt?: string;
  remainingUsd?: number | null;
  percentUsed?: number | null;
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

/**
 * Decode + unwrap + REQUIRE the fields the caller is about to render.
 *
 * The body used to end `return (body as { data: T }).data` — a cast, not a
 * check, so a 200 carrying `{"success":true,"data":{}}` produced an object whose
 * every field was `undefined`. Measured on the built CLI:
 *
 *     $ evalguard budget limits <keyId> --tpm 10
 *       ✓ updated limits for undefined
 *     $ echo $?
 *     0
 *
 * — a WRITE command reporting a successful update of a key it could not name.
 */
async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  required: readonly string[] = [],
): Promise<T> {
  const res = await boundedFetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return expectResult<T>(body, path, required);
}

/** The BudgetView fields `renderView` reads unconditionally (two are .toFixed'd). */
const BUDGET_FIELDS = ["monthlyBudgetUsd", "currentPeriodSpentUsd"] as const;

/** `apiFetch<BudgetView>` with that contract applied — used by every budget read/write. */
const apiFetchBudget = (path: string, init: RequestInit = {}): Promise<BudgetView> =>
  apiFetch<BudgetView>(path, init, BUDGET_FIELDS);

/**
 * Format a USD amount that the server may legitimately omit.
 *
 * `remainingUsd` and `percentUsed` are DERIVED columns — the route computes
 * them only when a cap exists — so a perfectly valid 200 can arrive without
 * them. The guards here were `=== null`, and `undefined === null` is false, so
 * an absent field fell through to `undefined.toFixed(4)`:
 *
 *     TypeError: Cannot read properties of undefined (reading 'toFixed')
 *         at renderView (…/dist/commands/budget.js:…)
 *
 * — an unhandled stack, not a refusal. `== null` catches both, which is the
 * whole fix; `BUDGET_FIELDS` already guarantees the two fields the renderer
 * genuinely cannot do without.
 */
function fmtUsd(value: number | null | undefined, digits: number): string {
  return value == null ? chalk.dim("—") : `$${value.toFixed(digits)}`;
}

function renderView(v: BudgetView): void {
  const cap = fmtUsd(v.monthlyBudgetUsd, 2);
  const spent = fmtUsd(v.currentPeriodSpentUsd, 4);
  const remaining = fmtUsd(v.remainingUsd, 4);
  const pctStr =
    v.percentUsed == null
      ? chalk.dim("—")
      : v.percentUsed >= 100
      ? chalk.red(`${v.percentUsed.toFixed(1)}%`)
      : v.percentUsed >= 80
      ? chalk.yellow(`${v.percentUsed.toFixed(1)}%`)
      : chalk.green(`${v.percentUsed.toFixed(1)}%`);

  console.log();
  // `?? "—"` rather than `??` alone: `name` and `keyId` are both optional on a
  // real 200, and `chalk.bold(undefined)` prints the literal word "undefined".
  console.log(`  ${chalk.bold(v.name ?? v.keyId ?? "—")}`);
  console.log(`  ${chalk.dim("Key")}       ${v.keyId ?? chalk.dim("—")}`);
  console.log(`  ${chalk.dim("Cap")}       ${cap}`);
  console.log(`  ${chalk.dim("Cadence")}   ${v.resetPeriod ?? "monthly"}`);
  console.log(`  ${chalk.dim("Spent")}     ${spent}`);
  console.log(`  ${chalk.dim("Remaining")} ${remaining}`);
  console.log(`  ${chalk.dim("Usage")}     ${pctStr}`);
  console.log(`  ${chalk.dim("Period")}    ${v.currentPeriodStartedAt ?? chalk.dim("—")}`);
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
    .action(async (rawKeyId: string, opts: { json?: boolean }) => {
      const keyId = keyIdArg(rawKeyId);
      const v = await apiFetchBudget(`/api-keys/${keyId}/budget`);
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
    .action(async (rawKeyId: string, usd: string, opts: { resetPeriod?: string }) => {
      const keyId = keyIdArg(rawKeyId);
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
      const v = await apiFetchBudget(`/api-keys/${keyId}/budget`, {
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
    .action(async (rawKeyId: string, cadence: string) => {
      const keyId = keyIdArg(rawKeyId);
      if (!["daily", "weekly", "monthly"].includes(cadence)) {
        console.error(chalk.red("Cadence must be one of: daily, weekly, monthly"));
        process.exit(1);
      }
      const v = await apiFetchBudget(`/api-keys/${keyId}/budget`, {
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
        rawKeyId: string,
        opts: {
          tpm?: string;
          rpm?: string;
          maxParallel?: string;
          models?: string;
          clearModels?: boolean;
        },
      ) => {
        const keyId = keyIdArg(rawKeyId);
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
        }>(
          `/api-keys/${keyId}`,
          { method: "PATCH", body: JSON.stringify(payload) },
          ["id", "name"],
        );

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
    .action(async (rawKeyId: string, opts: { dryRun?: boolean }) => {
      const keyId = keyIdArg(rawKeyId);
      // E2 (2026-05-19): removing a spend cap is destructive — the key
      // becomes uncapped and a buggy or compromised caller could burn
      // through any amount before someone notices. --dry-run lets ops
      // verify the current cap before tearing it down.
      if (opts.dryRun) {
        const current = await apiFetchBudget(`/api-keys/${keyId}/budget`);
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
      await apiFetchBudget(`/api-keys/${keyId}/budget`, { method: "DELETE" });
      console.log(chalk.green(`✓ cap removed — ${keyId} is now unlimited`));
    });
}
