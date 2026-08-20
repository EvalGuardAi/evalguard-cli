/**
 * `evalguard agent-memory` — two-tier agent memory (long-term semantic recall)
 * plus the org's memory-governance policy.
 *
 *   evalguard agent-memory remember --project <id> --session <key> --fact "..." [--fact "..."]
 *   evalguard agent-memory remember --project <id> --session <key> --facts-file facts.json
 *   evalguard agent-memory recall   --project <id> --session <key> [--query "..."] [--limit 5]
 *   evalguard agent-memory forget   --project <id> --session <key>
 *   evalguard agent-memory governance get [--org <id>] [--project <id>]
 *   evalguard agent-memory governance set --org <id> --mode <off|monitor|enforce>
 *       [--project <id>] [--enable|--disable] [--require-approval-on-rewrite]
 *       [--require-provenance] [--poison-min-confidence <n>]
 *
 * The API functions take an injectable `fetchImpl` so they're unit-testable
 * offline (mirrors agent-tools.ts). Output unwraps the { success, data } envelope.
 * `governance` is admin-only server-side (createApiHandler requiredRole:"admin");
 * this command is a thin client over GET/PUT /agent-memory/governance.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectArrayField,
  expectField,
  expectResult,
  unwrapApiEnvelope,
} from "../lib/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: MemoryApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? boundedFetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function rememberMemory(
  args: { projectId: string; sessionKey: string; facts?: string[]; agentId?: string } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.sessionKey) throw new Error("sessionKey is required");
  if (!args.facts?.length) throw new Error("at least one --fact (or --facts-file) is required");
  return call(
    "/agent-memory",
    { method: "POST", body: JSON.stringify({ projectId: args.projectId, sessionKey: args.sessionKey, facts: args.facts, agentId: args.agentId }) },
    args,
  );
}

export async function recallMemory(
  args: { projectId: string; sessionKey: string; query?: string; limit?: number } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.sessionKey) throw new Error("sessionKey is required");
  const q = new URLSearchParams({ projectId: args.projectId, sessionKey: args.sessionKey });
  if (args.query) q.set("query", args.query);
  if (args.limit != null) q.set("limit", String(args.limit));
  return call(`/agent-memory?${q.toString()}`, { method: "GET" }, args);
}

export async function forgetMemory(
  args: { projectId: string; sessionKey: string } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.sessionKey) throw new Error("sessionKey is required");
  const q = new URLSearchParams({ projectId: args.projectId, sessionKey: args.sessionKey });
  return call(`/agent-memory?${q.toString()}`, { method: "DELETE" }, args);
}

// ── Governance policy (admin) ───────────────────────────────────────────────
// Kept in lock-step with the route's mode enum (off|monitor|enforce) and the
// core MemoryGovernanceMode union.
export const MEMORY_GOVERNANCE_MODES = ["off", "monitor", "enforce"] as const;
export type MemoryGovernanceMode = (typeof MEMORY_GOVERNANCE_MODES)[number];

/** The flat governance knobs a caller passes; mapped to the route's config JSONB. */
export interface MemoryGovernanceConfigInput {
  /** Min poisoning-screen confidence (0..1) to act on a flagged memory. */
  poisonMinConfidence?: number;
  /** Require human approval before an autonomous rewrite/consolidate proceeds. */
  requireApprovalOnRewrite?: boolean;
  /** Flag any governed memory that lacks a provenance `source`. */
  requireProvenance?: boolean;
}

/** The policy shape the route returns (mirrors MemoryGovernancePolicy on the server). */
export interface MemoryGovernancePolicyView {
  orgId: string;
  projectId: string | null;
  enabled: boolean;
  mode: MemoryGovernanceMode;
  config: {
    thresholds?: { poisonMinConfidence?: number };
    requireApprovalOnRewrite?: boolean;
    requireProvenance?: boolean;
  };
  updatedAt: string;
}

/**
 * Build the route's strict `config` JSONB from the flat CLI knobs. `poisonMinConfidence`
 * nests under `thresholds` (matching MemoryGovernanceConfig in @evalguard/core and the
 * route's `.strict()` ConfigSchema). Returns undefined when no knob was set so the
 * server leaves an existing config untouched.
 */
function buildGovernanceConfig(c: MemoryGovernanceConfigInput): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (c.poisonMinConfidence !== undefined) config.thresholds = { poisonMinConfidence: c.poisonMinConfidence };
  if (c.requireApprovalOnRewrite !== undefined) config.requireApprovalOnRewrite = c.requireApprovalOnRewrite;
  if (c.requireProvenance !== undefined) config.requireProvenance = c.requireProvenance;
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * GET the org's agent-memory governance policy. `orgId`/`projectId` are optional:
 * when omitted, the server resolves org scope from the API key (resolveOrgId). A
 * project value scopes to a project; absent = the org-wide policy.
 */
export async function getMemoryGovernance(
  args: { orgId?: string; projectId?: string } & MemoryApiOpts,
): Promise<unknown> {
  if (args.orgId && !UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (args.projectId && !UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const q = new URLSearchParams();
  if (args.orgId) q.set("orgId", args.orgId);
  if (args.projectId) q.set("projectId", args.projectId);
  const qs = q.toString();
  return call(`/agent-memory/governance${qs ? `?${qs}` : ""}`, { method: "GET" }, args);
}

/**
 * PUT (upsert) the org(+project) governance policy. `orgId` is required — the
 * route's UpsertBody schema demands a UUID. At least one mutable knob must be set.
 */
export async function setMemoryGovernance(
  args: {
    orgId: string;
    projectId?: string | null;
    enabled?: boolean;
    mode?: MemoryGovernanceMode;
    config?: MemoryGovernanceConfigInput;
  } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (args.projectId != null && !UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (args.mode && !(MEMORY_GOVERNANCE_MODES as readonly string[]).includes(args.mode)) {
    throw new Error(`mode must be one of: ${MEMORY_GOVERNANCE_MODES.join(", ")}`);
  }
  const config = args.config ? buildGovernanceConfig(args.config) : undefined;
  if (args.enabled === undefined && args.mode === undefined && config === undefined) {
    throw new Error(
      "Nothing to set — pass at least one of --mode / --enable / --disable / --require-approval-on-rewrite / --require-provenance / --poison-min-confidence",
    );
  }
  const payload: Record<string, unknown> = { orgId: args.orgId };
  if (args.projectId !== undefined) payload.projectId = args.projectId;
  if (args.enabled !== undefined) payload.enabled = args.enabled;
  if (args.mode !== undefined) payload.mode = args.mode;
  if (config !== undefined) payload.config = config;
  return call("/agent-memory/governance", { method: "PUT", body: JSON.stringify(payload) }, args);
}

function envConfig(): MemoryApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Pretty-print a governance policy for the non-JSON path. */
function printGovernancePolicy(policy: MemoryGovernancePolicyView): void {
  const scope = policy.projectId ? `project ${chalk.cyan(policy.projectId)}` : chalk.dim("org-wide");
  const enabled = policy.enabled ? chalk.green("enabled") : chalk.dim("disabled");
  const poison = policy.config?.thresholds?.poisonMinConfidence;
  console.log();
  console.log(chalk.bold("  Agent-memory governance policy"));
  console.log(chalk.dim("  ─────────────────────────────────────────────"));
  console.log(`  Scope:                 ${scope}`);
  console.log(`  Status:                ${enabled}`);
  console.log(`  Mode:                  ${chalk.bold(policy.mode)}`);
  console.log(`  Approval on rewrite:   ${policy.config?.requireApprovalOnRewrite ? chalk.green("required") : chalk.dim("no")}`);
  console.log(`  Require provenance:    ${policy.config?.requireProvenance ? chalk.green("yes") : chalk.dim("no")}`);
  console.log(`  Poison min confidence: ${poison !== undefined ? chalk.bold(String(poison)) : chalk.dim("default")}`);
  console.log(chalk.dim(`  Updated: ${policy.updatedAt}`));
  console.log();
}

export function registerAgentMemory(program: Command): void {
  const cmd = program.command("agent-memory").description("Two-tier agent memory — long-term semantic remember/recall/forget");

  cmd
    .command("remember")
    .description("Store durable facts for a session (deduped + embedded)")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--session <key>", "Session key (e.g. a user id)")
    .option("--fact <text>", "A fact to remember (repeatable)", collect, [])
    .option("--facts-file <path>", "JSON file with an array of fact strings")
    .option("--agent <id>", "Originating agent id")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; session: string; fact: string[]; factsFile?: string; agent?: string; json?: boolean }) => {
      try {
        let facts = opts.fact ?? [];
        if (opts.factsFile) {
          const fs = await import("node:fs");
          const parsed = JSON.parse(fs.readFileSync(opts.factsFile, "utf8"));
          if (!Array.isArray(parsed)) throw new Error("--facts-file must contain a JSON array of strings");
          facts = [...facts, ...parsed.filter((x): x is string => typeof x === "string")];
        }
        // "✓ Remembered N fact(s)" must come from the server's own accounting;
        // the cast made `written`/`skipped` undefined and the renderer would then
        // throw on `.length` — fail-closed by accident rather than by contract.
        const result = expectResult<{ written: string[]; skipped: string[] }>(
          await rememberMemory({ projectId: opts.project, sessionKey: opts.session, facts, agentId: opts.agent, ...envConfig() }),
          "POST /agent-memory/remember",
        );
        expectArrayField(result, "written", "POST /agent-memory/remember");
        expectArrayField(result, "skipped", "POST /agent-memory/remember");
        if (opts.json) return void console.log(JSON.stringify(result, null, 2));
        console.log(chalk.green(`  ✓ Remembered ${result.written.length} fact(s)`) + (result.skipped.length ? chalk.dim(`, ${result.skipped.length} skipped as duplicates`) : ""));
      } catch (e) {
        console.error(chalk.red(`agent-memory remember failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("recall")
    .description("Recall a session's memory by semantic similarity to a query")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--session <key>", "Session key")
    .option("--query <text>", "Query to recall against (omit to list recent)")
    .option("--limit <n>", "Max results", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; session: string; query?: string; limit?: number; json?: boolean }) => {
      try {
        const body = await recallMemory({ projectId: opts.project, sessionKey: opts.session, query: opts.query, limit: opts.limit, ...envConfig() });
        const hits = expectArrayField(
          unwrapApiEnvelope(body, "POST /agent-memory/recall"),
          "semantic",
          "POST /agent-memory/recall",
        ) as { content: string; score: number | null }[];
        if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
        if (hits.length === 0) return void console.log(chalk.dim("  No memory recalled."));
        console.log(chalk.bold(`\n  Recalled ${hits.length} memory item(s)\n`));
        for (const h of hits) {
          const score = h.score != null ? chalk.dim(` (${h.score.toFixed(3)})`) : "";
          console.log(`  • ${h.content}${score}`);
        }
        console.log();
      } catch (e) {
        console.error(chalk.red(`agent-memory recall failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("forget")
    .description("Forget a session's long-term memory")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--session <key>", "Session key")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; session: string; json?: boolean }) => {
      try {
        const body = await forgetMemory({ projectId: opts.project, sessionKey: opts.session, ...envConfig() });
        // `?? 0` printed "✓ Forgot 0 memory item(s)" — a success message — for a
        // response that never said anything was forgotten.
        const forgotten = expectField(
          unwrapApiEnvelope(body, "POST /agent-memory/forget"),
          "forgotten",
          "POST /agent-memory/forget",
        ) as number;
        if (opts.json) return void console.log(JSON.stringify({ forgotten }, null, 2));
        console.log(chalk.green(`  ✓ Forgot ${forgotten} memory item(s)`));
      } catch (e) {
        console.error(chalk.red(`agent-memory forget failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  const gov = cmd
    .command("governance")
    .description("Read / write the org's agent-memory governance policy (mode + thresholds — admin only)");

  gov
    .command("get")
    .description("Show the agent-memory governance policy (null when none is set)")
    .option("--org <id>", "Org UUID (defaults to your API key's org)")
    .option("--project <id>", "Project UUID to scope to (omit for the org-wide policy)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org?: string; project?: string; json?: boolean }) => {
      try {
        const body = await getMemoryGovernance({ orgId: opts.org, projectId: opts.project, ...envConfig() });
        // A null `policy` is a REAL answer ("ungoverned"), so it is allowed —
        // but a body with NO `policy` key is not this route's answer at all.
        // The old `?? ... ?? null` chain collapsed both into "ungoverned" and
        // exited 0 against an unrelated 200 (measured 2026-08-08).
        const policy = expectField(
          unwrapApiEnvelope(body, "GET /agent-memory/governance"),
          "policy",
          "GET /agent-memory/governance",
        ) as MemoryGovernancePolicyView | null;
        if (opts.json) return void console.log(JSON.stringify(policy, null, 2));
        if (!policy) return void console.log(chalk.dim("  No governance policy set — memory writes are ungoverned."));
        printGovernancePolicy(policy);
      } catch (e) {
        console.error(chalk.red(`agent-memory governance get failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  gov
    .command("set")
    .description("Create or update the agent-memory governance policy (admin only)")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--mode <mode>", `Enforcement mode: ${MEMORY_GOVERNANCE_MODES.join(" | ")}`)
    .option("--project <id>", "Project UUID to scope to (omit for the org-wide policy)")
    .option("--enable", "Enable the policy")
    .option("--disable", "Disable the policy")
    .option("--require-approval-on-rewrite", "Require human approval before an autonomous rewrite/consolidate")
    .option("--require-provenance", "Flag any governed memory that lacks a provenance source")
    .option("--poison-min-confidence <n>", "Min poisoning-screen confidence (0..1) to act", (v) => parseFloat(v))
    .option("--json", "Output the saved policy as JSON", false)
    .action(
      async (opts: {
        org: string;
        mode: string;
        project?: string;
        enable?: boolean;
        disable?: boolean;
        requireApprovalOnRewrite?: boolean;
        requireProvenance?: boolean;
        poisonMinConfidence?: number;
        json?: boolean;
      }) => {
        try {
          if (opts.enable && opts.disable) {
            console.error(chalk.red("  Pass only one of --enable / --disable."));
            process.exit(1);
          }
          if (!(MEMORY_GOVERNANCE_MODES as readonly string[]).includes(opts.mode)) {
            console.error(chalk.red(`  Unknown mode: ${opts.mode}. Choose: ${MEMORY_GOVERNANCE_MODES.join(" | ")}`));
            process.exit(1);
          }
          const config: MemoryGovernanceConfigInput = {};
          if (opts.requireApprovalOnRewrite) config.requireApprovalOnRewrite = true;
          if (opts.requireProvenance) config.requireProvenance = true;
          if (opts.poisonMinConfidence !== undefined) config.poisonMinConfidence = opts.poisonMinConfidence;
          const enabled = opts.enable ? true : opts.disable ? false : undefined;

          const body = (await setMemoryGovernance({
            orgId: opts.org,
            projectId: opts.project,
            enabled,
            mode: opts.mode as MemoryGovernanceMode,
            config: Object.keys(config).length > 0 ? config : undefined,
            ...envConfig(),
          })) as { data?: { policy: MemoryGovernancePolicyView }; policy?: MemoryGovernancePolicyView };
          const policy = body.data?.policy ?? body.policy ?? null;
          if (opts.json) return void console.log(JSON.stringify(policy, null, 2));
          console.log(chalk.green("  ✓ Governance policy saved"));
          if (policy) printGovernancePolicy(policy);
        } catch (e) {
          console.error(chalk.red(`agent-memory governance set failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );
}
