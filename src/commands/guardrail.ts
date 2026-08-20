/**
 * `evalguard guardrail` — per-project GATEWAY guardrail-config management.
 *
 *   evalguard guardrail list --project <id> [--json]
 *   evalguard guardrail set  --org <id> --project <id> --vendor <v>
 *       [--on-flag block|redact|flag] [--check-request|--no-check-request]
 *       [--check-response|--no-check-response] [--tokenize-pii|--no-tokenize-pii]
 *       [--enabled|--disabled] [--priority <n>] [--secret-ref <uuid>]
 *       [--config <json>] [--json]
 *   evalguard guardrail rm   --project <id> --vendor <v> [--json]
 *
 * Thin client over GET/POST/DELETE /api/v1/gateway/guardrails (admin, org-scoped).
 * `set` is idempotent on (project, vendor) — re-running updates in place rather
 * than stacking duplicate plugins. The API fns take an injectable `fetchImpl`
 * so they're unit-testable offline (mirrors guardrail-shadow.ts / agent-tools.ts);
 * output unwraps the { success, data } envelope.
 *
 * LOCAL vs VENDOR secretRef rule (CRITICAL — mirrors the route):
 *   - LOCAL presets (local-firewall / moderated-firewall / the two Wave-2 agent
 *     guardrails data-not-instructions + tool-call-circuit-breaker) make NO
 *     external call and MUST NOT carry a secretRef — the client never sends one.
 *   - VENDOR adapters (aporia / lakera / …) REQUIRE a secretRef pointing at a
 *     stored provider_keys row; the client demands `--secret-ref` for them.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { failExit } from "../lib/poll.js";
import { boundedFetch, decodeJsonBody, expectArray, unwrapApiEnvelope } from "../lib/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The on_flag verdict actions the route's PostBody accepts. */
export const GUARDRAIL_ON_FLAG = ["block", "redact", "flag"] as const;
export type GuardrailOnFlag = (typeof GUARDRAIL_ON_FLAG)[number];

/**
 * The LOCAL guardrail vendors — dependency-free presets that make NO external
 * call and therefore MUST NOT carry a secretRef. Kept in lock-step with
 * `LOCAL_GUARDRAIL_VENDORS` in apps/web/src/lib/gateway-guardrail-config.ts and
 * the @evalguard/core guardrail modules. The two Wave-2 agent guardrails
 * (`data-not-instructions`, `tool-call-circuit-breaker`) are local. Every OTHER
 * `--vendor` value is treated as a partner adapter that REQUIRES a secretRef.
 */
export const LOCAL_GUARDRAIL_VENDORS = [
  "local-firewall",
  "moderated-firewall",
  "data-not-instructions",
  "tool-call-circuit-breaker",
] as const;
export type LocalGuardrailVendor = (typeof LOCAL_GUARDRAIL_VENDORS)[number];

/** True when `vendor` is a LOCAL preset (no external call, no secretRef). */
export function isLocalGuardrailVendor(vendor: string): boolean {
  return (LOCAL_GUARDRAIL_VENDORS as readonly string[]).includes(vendor);
}

export interface GuardrailApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** A gateway_guardrail_config row as returned by the route (snake_case columns). */
export interface GuardrailConfigRowView {
  id: string;
  org_id: string;
  project_id: string;
  vendor: string;
  vendor_chain?: string[] | null;
  fallback_on_errors?: string[] | null;
  config: Record<string, unknown>;
  secret_ref: string | null;
  on_flag: GuardrailOnFlag;
  check_request: boolean;
  check_response: boolean;
  tokenize_pii: boolean;
  enabled: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

async function call(path: string, init: RequestInit, opts: GuardrailApiOpts): Promise<unknown> {
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

function unwrap(body: unknown, endpoint = "the guardrail API"): unknown {
  // Delegates to the shared contract. The previous body was
  // `(body as {data?})?.data ?? body`, whose `?? body` handed the whole envelope
  // back when `data` was null and passed an unrelated 200 straight through —
  // the consumer's `?? []` then rendered it as an empty list, exit 0.
  return unwrapApiEnvelope(body, endpoint);
}

/** GET /gateway/guardrails?projectId=… — list a project's guardrail-config rows. */
export async function listGuardrailConfigs(
  args: { projectId: string } & GuardrailApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId });
  return call(`/gateway/guardrails?${qs.toString()}`, { method: "GET" }, args);
}

/** The flat knobs `set` maps onto the route's POST body (only provided fields are sent). */
export interface SetGuardrailArgs {
  orgId: string;
  projectId: string;
  vendor: string;
  config?: Record<string, unknown>;
  onFlag?: GuardrailOnFlag;
  checkRequest?: boolean;
  checkResponse?: boolean;
  tokenizePii?: boolean;
  enabled?: boolean;
  priority?: number;
  /** A provider_keys UUID — REQUIRED for vendor adapters, forbidden for local presets. */
  secretRef?: string | null;
}

/**
 * POST /gateway/guardrails — upsert a project's guardrail config (idempotent on
 * project+vendor). Enforces the local-vs-vendor secretRef rule client-side so a
 * misuse fails fast with a clear message rather than a 400 round-trip, and so a
 * secretRef is NEVER emitted for a local preset.
 */
export async function setGuardrailConfig(
  args: SetGuardrailArgs & GuardrailApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.vendor) throw new Error("vendor is required");
  if (args.onFlag && !(GUARDRAIL_ON_FLAG as readonly string[]).includes(args.onFlag)) {
    throw new Error(`onFlag must be one of: ${GUARDRAIL_ON_FLAG.join(", ")}`);
  }
  const local = isLocalGuardrailVendor(args.vendor);
  if (local && args.secretRef) {
    throw new Error(
      `Local guardrail '${args.vendor}' makes no external call and must not carry a secretRef`,
    );
  }
  if (!local && !args.secretRef) {
    throw new Error(
      `Vendor guardrail '${args.vendor}' requires a secretRef (a stored provider-key UUID)`,
    );
  }
  if (args.secretRef && !UUID_RE.test(args.secretRef)) {
    throw new Error("secretRef must be a valid UUID");
  }

  const payload: Record<string, unknown> = {
    orgId: args.orgId,
    projectId: args.projectId,
    vendor: args.vendor,
  };
  if (args.config !== undefined) payload.config = args.config;
  if (args.onFlag !== undefined) payload.onFlag = args.onFlag;
  if (args.checkRequest !== undefined) payload.checkRequest = args.checkRequest;
  if (args.checkResponse !== undefined) payload.checkResponse = args.checkResponse;
  if (args.tokenizePii !== undefined) payload.tokenizePii = args.tokenizePii;
  if (args.enabled !== undefined) payload.enabled = args.enabled;
  if (args.priority !== undefined) payload.priority = args.priority;
  // secretRef is only ever sent for a VENDOR guardrail — never a local preset.
  if (!local && args.secretRef) payload.secretRef = args.secretRef;

  return call("/gateway/guardrails", { method: "POST", body: JSON.stringify(payload) }, args);
}

/** DELETE /gateway/guardrails?projectId=…&id=… — remove one config row by id. */
export async function deleteGuardrailConfig(
  args: { projectId: string; id: string } & GuardrailApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!UUID_RE.test(args.id)) throw new Error("id must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId, id: args.id });
  return call(`/gateway/guardrails?${qs.toString()}`, { method: "DELETE" }, args);
}

/**
 * Resolve the config-row id for a (project, vendor) pair by listing the
 * project's rows and matching on `vendor` (the upsert key). Returns null when
 * the project has no row for that vendor. Lets `rm --vendor` delete by the same
 * key `set` writes on, without the caller needing the row's UUID.
 */
export async function findGuardrailIdByVendor(
  args: { projectId: string; vendor: string } & GuardrailApiOpts,
): Promise<string | null> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.vendor) throw new Error("vendor is required");
  const body = await listGuardrailConfigs({
    projectId: args.projectId,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    fetchImpl: args.fetchImpl,
  });
  // `Array.isArray(rows) ? … : undefined` returned null for an unreadable
  // response, which every caller reads as "no config exists for this vendor" —
  // and then creates a duplicate, or reports the guardrail as absent.
  const rows = expectArray(
    unwrap(body, "GET /gateway/guardrails"),
    "GET /gateway/guardrails",
  ) as GuardrailConfigRowView[];
  return rows.find((r) => r.vendor === args.vendor)?.id ?? null;
}

function envConfig(): GuardrailApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

/** Pretty-print one config row for the non-JSON list path. */
function printRow(r: GuardrailConfigRowView): void {
  const on = r.enabled ? chalk.green("on") : chalk.dim("off");
  const kind = isLocalGuardrailVendor(r.vendor) ? chalk.dim("local") : chalk.magenta("vendor");
  const secret = r.secret_ref ? chalk.dim(" secret✓") : "";
  console.log(
    `  ${chalk.cyan(r.id)}  ${chalk.bold(r.vendor)} [${kind}]  on_flag=${r.on_flag}` +
      `  req=${r.check_request} res=${r.check_response} pii=${r.tokenize_pii}` +
      `  priority=${r.priority}  [${on}]${secret}`,
  );
}

export function registerGuardrail(program: Command): void {
  const cmd = program
    .command("guardrail")
    .description(
      "Manage per-project gateway guardrail configs (partner adapters + local agent guardrails)",
    );

  cmd
    .command("list")
    .description("List a project's gateway guardrail configs")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; json?: boolean }) => {
      try {
        // `!Array.isArray(data)` used to fall into the SAME branch as an
        // empty list, so a 200 carrying an unrelated object printed the empty
        // state and exited 0 (measured 2026-08-08). expectArray separates
        // "not a list" from "an empty list"; the latter is still fine.
        const data = expectArray(
          unwrap(
            await listGuardrailConfigs({ projectId: opts.project, ...envConfig() }),
            "GET /gateway/guardrails",
          ),
          "GET /gateway/guardrails",
        ) as GuardrailConfigRowView[];
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (!Array.isArray(data) || data.length === 0) {
          console.log(chalk.dim("  (no guardrail configs)"));
          return;
        }
        for (const r of data) printRow(r);
      } catch (e) {
        failExit(chalk.red(`guardrail list failed: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
    });

  cmd
    .command("set")
    .description("Create or update a project's guardrail config (idempotent on project + vendor)")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption(
      "--vendor <vendor>",
      `Guardrail vendor. Local presets (no secret): ${LOCAL_GUARDRAIL_VENDORS.join(
        " | ",
      )}. Any other value is a partner adapter and needs --secret-ref.`,
    )
    .option("--on-flag <action>", `Verdict action: ${GUARDRAIL_ON_FLAG.join(" | ")}`)
    // Positive flags declared BEFORE their --no- counterparts so commander leaves
    // the value undefined (tri-state) instead of defaulting the negation to true.
    .option("--check-request", "Scan the request side")
    .option("--no-check-request", "Do not scan the request side")
    .option("--check-response", "Scan the response side")
    .option("--no-check-response", "Do not scan the response side")
    .option("--tokenize-pii", "Reversibly tokenize PII in the request")
    .option("--no-tokenize-pii", "Do not tokenize PII")
    .option("--enabled", "Enable this guardrail")
    .option("--disabled", "Disable this guardrail")
    .option("--priority <n>", "Ordering priority (lower runs first)", (v) => parseInt(v, 10))
    .option(
      "--secret-ref <uuid>",
      "provider_keys UUID — REQUIRED for partner vendors, forbidden for local presets",
    )
    .option(
      "--config <json>",
      'Vendor config knobs as a JSON object (e.g. tool-call-circuit-breaker: \'{"maxRepeats":3}\')',
    )
    .option("--json", "Output the saved config as JSON", false)
    .action(
      async (opts: {
        org: string;
        project: string;
        vendor: string;
        onFlag?: string;
        checkRequest?: boolean;
        checkResponse?: boolean;
        tokenizePii?: boolean;
        enabled?: boolean;
        disabled?: boolean;
        priority?: number;
        secretRef?: string;
        config?: string;
        json?: boolean;
      }) => {
        try {
          if (opts.enabled && opts.disabled) {
            console.error(chalk.red("  Pass only one of --enabled / --disabled."));
            process.exit(1);
          }
          if (opts.onFlag && !(GUARDRAIL_ON_FLAG as readonly string[]).includes(opts.onFlag)) {
            console.error(
              chalk.red(`  Unknown --on-flag: ${opts.onFlag}. Choose: ${GUARDRAIL_ON_FLAG.join(" | ")}`),
            );
            process.exit(1);
          }
          let config: Record<string, unknown> | undefined;
          if (opts.config !== undefined) {
            const parsed: unknown = JSON.parse(opts.config);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("--config must be a JSON object");
            }
            config = parsed as Record<string, unknown>;
          }
          const enabled = opts.enabled ? true : opts.disabled ? false : undefined;

          const data = unwrap(
            await setGuardrailConfig({
              orgId: opts.org,
              projectId: opts.project,
              vendor: opts.vendor,
              onFlag: opts.onFlag as GuardrailOnFlag | undefined,
              checkRequest: opts.checkRequest,
              checkResponse: opts.checkResponse,
              tokenizePii: opts.tokenizePii,
              enabled,
              priority: opts.priority,
              secretRef: opts.secretRef,
              config,
              ...envConfig(),
            }),
          ) as GuardrailConfigRowView | null;
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(
            chalk.green(
              `  ✓ Saved guardrail ${chalk.bold(opts.vendor)} for project ${chalk.cyan(opts.project)}`,
            ),
          );
          if (data) printRow(data);
        } catch (e) {
          console.error(chalk.red(`guardrail set failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );

  cmd
    .command("rm")
    .description("Delete a project's guardrail config for a vendor")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--vendor <vendor>", "Vendor whose config to delete")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; vendor: string; json?: boolean }) => {
      try {
        const env = envConfig();
        const id = await findGuardrailIdByVendor({ projectId: opts.project, vendor: opts.vendor, ...env });
        if (!id) {
          console.error(
            chalk.red(`  No guardrail config for vendor '${opts.vendor}' on project ${opts.project}.`),
          );
          process.exit(1);
        }
        const data = unwrap(await deleteGuardrailConfig({ projectId: opts.project, id, ...env }));
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(chalk.green(`  ✓ Deleted guardrail ${chalk.bold(opts.vendor)}`));
      } catch (e) {
        console.error(chalk.red(`guardrail rm failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
