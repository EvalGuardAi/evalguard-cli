/**
 * `evalguard regression-trigger` — continuous red-team on change.
 *
 *   evalguard regression-trigger fire   --org <id> --project <id> --change-type <t>
 *                                       [--risk <low|medium|high|critical>] [--resource <id>] [--json]
 *   evalguard regression-trigger config get --org <id> --project <id> [--json]
 *   evalguard regression-trigger config set --org <id> --project <id>
 *                                       [--enabled <true|false>] [--min-risk <r>] [--change-types <csv>] [--json]
 *   evalguard regression-trigger log    --org <id> --project <id> [--limit <n>] [--json]
 *
 * `fire` is the CI/webhook entry point: plan a regression rerun for a change
 * event and, when the project has opted in, nudge the project's enabled
 * red-team campaigns to run now. `config` reads/sets the per-project opt-in.
 * `log` prints the decision ledger.
 *
 * The API-calling functions take an injectable `fetchImpl` so they're unit-
 * testable offline (mirrors abuse-report.ts / ai-bom.ts).
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { boundedFetch, decodeJsonBody, expectArray, expectResult, unwrapApiEnvelope } from "../lib/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RISKS = ["low", "medium", "high", "critical"] as const;
export type RegressionRisk = (typeof RISKS)[number];

export interface RegressionApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: RegressionApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? boundedFetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function fireRegressionTrigger(
  args: {
    orgId: string;
    projectId: string;
    changeType: string;
    riskLevel?: RegressionRisk;
    resourceId?: string;
  } & RegressionApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.changeType) throw new Error("changeType is required");
  const payload: Record<string, unknown> = {
    orgId: args.orgId,
    projectId: args.projectId,
    changeType: args.changeType,
  };
  if (args.riskLevel) payload.riskLevel = args.riskLevel;
  if (args.resourceId) payload.resourceId = args.resourceId;
  return call("/regression-tests/trigger", { method: "POST", body: JSON.stringify(payload) }, args);
}

export async function getRegressionConfig(
  args: { orgId: string; projectId: string } & RegressionApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ orgId: args.orgId, projectId: args.projectId });
  return call(`/regression-tests/config?${qs.toString()}`, { method: "GET" }, args);
}

export async function setRegressionConfig(
  args: {
    orgId: string;
    projectId: string;
    enabled?: boolean;
    minRiskLevel?: RegressionRisk;
    triggerChangeTypes?: string[] | null;
  } & RegressionApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const payload: Record<string, unknown> = { orgId: args.orgId, projectId: args.projectId };
  if (args.enabled !== undefined) payload.enabled = args.enabled;
  if (args.minRiskLevel !== undefined) payload.minRiskLevel = args.minRiskLevel;
  if (args.triggerChangeTypes !== undefined) payload.triggerChangeTypes = args.triggerChangeTypes;
  return call("/regression-tests/config", { method: "PUT", body: JSON.stringify(payload) }, args);
}

export async function listRegressionLog(
  args: { orgId: string; projectId: string; limit?: number } & RegressionApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ orgId: args.orgId, projectId: args.projectId });
  if (args.limit) qs.set("limit", String(args.limit));
  return call(`/regression-tests/log?${qs.toString()}`, { method: "GET" }, args);
}

function envConfig(): RegressionApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

function unwrap(body: unknown, endpoint = "the regression-trigger API"): unknown {
  // Delegates to the shared contract. The previous body was
  // `(body as {data?})?.data ?? body`, whose `?? body` handed the whole envelope
  // back when `data` was null and passed an unrelated 200 straight through —
  // the consumer's `?? []` then rendered it as an empty list, exit 0.
  return unwrapApiEnvelope(body, endpoint);
}

export function registerRegressionTrigger(program: Command): void {
  const cmd = program
    .command("regression-trigger")
    .description("Continuous red-team: auto re-run attack suites on prompt/model/guardrail changes");

  // ─── fire ───────────────────────────────────────────────────────────
  cmd
    .command("fire")
    .description("Plan + (if opted in) fire a regression rerun for a change event")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--change-type <type>", "e.g. prompt_edit | model_change | guardrail_config | deploy")
    .option("--risk <level>", `Risk: ${RISKS.join(" | ")}`)
    .option("--resource <id>", "Identifier of the changed resource")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: { org: string; project: string; changeType: string; risk?: string; resource?: string; json?: boolean }) => {
        try {
          if (opts.risk && !RISKS.includes(opts.risk as RegressionRisk)) {
            console.error(chalk.red(`--risk must be one of: ${RISKS.join(" | ")}`));
            process.exit(1);
          }
          // Same class as `config get` below, and the same reading: without
          // required fields, an unrelated 200 renders as
          // `opted in: no / rerun: no (not fired)` — a definitive "your change
          // triggered no red-team rerun" produced by falsy `undefined`s.
          const data = expectResult<{
            shouldRerun?: boolean;
            enabled?: boolean;
            suites?: string[];
            enqueued?: boolean;
            triggeredCampaignIds?: string[];
            reason?: string;
          }>(
            await fireRegressionTrigger({
              orgId: opts.org,
              projectId: opts.project,
              changeType: opts.changeType,
              riskLevel: opts.risk as RegressionRisk | undefined,
              resourceId: opts.resource,
              ...envConfig(),
            }),
            "POST /regression-tests/trigger",
            ["shouldRerun", "enabled"],
          );
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          const fired = data.enqueued ? chalk.green("FIRED") : chalk.dim("not fired");
          console.log(`  ${chalk.dim("opted in:  ")} ${data.enabled ? chalk.green("yes") : chalk.yellow("no")}`);
          console.log(`  ${chalk.dim("rerun:     ")} ${data.shouldRerun ? chalk.cyan("yes") : "no"}  (${fired})`);
          console.log(`  ${chalk.dim("suites:    ")} ${(data.suites ?? []).join(", ") || "—"}`);
          if (data.triggeredCampaignIds && data.triggeredCampaignIds.length > 0) {
            console.log(`  ${chalk.dim("campaigns: ")} ${data.triggeredCampaignIds.length} nudged`);
          }
          if (data.reason) console.log(`  ${chalk.dim("reason:    ")} ${data.reason}`);
        } catch (e) {
          console.error(chalk.red(e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
      },
    );

  // ─── config ─────────────────────────────────────────────────────────
  const config = cmd.command("config").description("Read/set the per-project opt-in");

  config
    .command("get")
    .description("Show the project's regression auto-trigger config")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; project: string; json?: boolean }) => {
      try {
        // `configured: no (defaults)` / `enabled: no` is a claim that this
        // project has NO continuous red-team opt-in. Measured before this
        // change, that exact screen printed with exit 0 for `{"hello":"world"}`
        // and `{"success":true,"data":{}}` — every line came from the `??`
        // defaults below, so "not configured" was reported without the server
        // ever saying so. `configured` + `enabled` are what make the body this
        // route's answer.
        const c = expectResult<{
          enabled?: boolean;
          min_risk_level?: string;
          trigger_change_types?: string[] | null;
          configured?: boolean;
        }>(
          await getRegressionConfig({ orgId: opts.org, projectId: opts.project, ...envConfig() }),
          "GET /regression-trigger/config",
          ["configured", "enabled"],
        );
        if (opts.json) {
          console.log(JSON.stringify(c, null, 2));
          return;
        }
        console.log(`  ${chalk.dim("configured:  ")} ${c.configured ? "yes" : chalk.dim("no (defaults)")}`);
        console.log(`  ${chalk.dim("enabled:     ")} ${c.enabled ? chalk.green("yes") : chalk.yellow("no")}`);
        console.log(`  ${chalk.dim("min risk:    ")} ${c.min_risk_level ?? "medium"}`);
        console.log(`  ${chalk.dim("change types:")} ${(c.trigger_change_types ?? []).join(", ") || chalk.dim("(planner defaults)")}`);
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  config
    .command("set")
    .description("Update the project's regression auto-trigger config (admin-only)")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .option("--enabled <bool>", "true | false")
    .option("--min-risk <level>", `Risk floor: ${RISKS.join(" | ")}`)
    .option("--change-types <csv>", "Comma-separated change types (empty string clears the override)")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: { org: string; project: string; enabled?: string; minRisk?: string; changeTypes?: string; json?: boolean }) => {
        try {
          if (opts.minRisk && !RISKS.includes(opts.minRisk as RegressionRisk)) {
            console.error(chalk.red(`--min-risk must be one of: ${RISKS.join(" | ")}`));
            process.exit(1);
          }
          let enabled: boolean | undefined;
          if (opts.enabled !== undefined) {
            if (opts.enabled !== "true" && opts.enabled !== "false") {
              console.error(chalk.red("--enabled must be 'true' or 'false'"));
              process.exit(1);
            }
            enabled = opts.enabled === "true";
          }
          let triggerChangeTypes: string[] | null | undefined;
          if (opts.changeTypes !== undefined) {
            const parts = opts.changeTypes.split(",").map((s) => s.trim()).filter(Boolean);
            triggerChangeTypes = parts.length > 0 ? parts : null;
          }
          const data = unwrap(
            await setRegressionConfig({
              orgId: opts.org,
              projectId: opts.project,
              enabled,
              minRiskLevel: opts.minRisk as RegressionRisk | undefined,
              triggerChangeTypes,
              ...envConfig(),
            }),
          );
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          const c = data as { enabled?: boolean; min_risk_level?: string };
          console.log(chalk.green(`  ✓ Updated — enabled=${c.enabled ? "yes" : "no"}, min risk=${c.min_risk_level ?? "medium"}`));
        } catch (e) {
          console.error(chalk.red(e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
      },
    );

  // ─── log ────────────────────────────────────────────────────────────
  cmd
    .command("log")
    .description("Show the regression auto-trigger decision ledger (newest first)")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .option("--limit <n>", "Max rows (1–200)", "50")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; project: string; limit?: string; json?: boolean }) => {
      try {
        const limit = opts.limit ? Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 50)) : 50;
        // `!Array.isArray(data)` used to fall into the SAME branch as an
        // empty list, so a 200 carrying an unrelated object printed the empty
        // state and exited 0 (measured 2026-08-08). expectArray separates
        // "not a list" from "an empty list"; the latter is still fine.
        const data = expectArray(
          unwrap(
            await listRegressionLog({ orgId: opts.org, projectId: opts.project, limit, ...envConfig() }),
            "GET /regression-tests/log",
          ),
          "GET /regression-tests/log",
        ) as Array<{
          created_at: string;
          change_type: string;
          risk_level: string;
          should_rerun: boolean;
          enqueued: boolean;
          suites: string[];
          reason: string;
        }>;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (!Array.isArray(data) || data.length === 0) {
          console.log(chalk.dim("  (no decisions logged yet)"));
          return;
        }
        for (const r of data) {
          const fired = r.enqueued ? chalk.green("FIRED") : chalk.dim("skipped");
          console.log(
            `  ${chalk.dim(r.created_at)}  ${chalk.cyan(r.change_type)}/${r.risk_level}  ${fired}  ${chalk.dim((r.suites ?? []).join(","))}`,
          );
        }
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });
}
