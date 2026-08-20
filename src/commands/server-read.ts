/**
 * Server-READ commands — surface the things the EvalGuard SERVER persists so a
 * user can inspect them from the terminal without opening the dashboard. These
 * complement the local-only `history`/`view` commands (which read
 * `~/.evalguard/results.json`).
 *
 *   evalguard runs                      — list eval runs        (GET /evals?projectId)
 *   evalguard runs:get <id>             — one eval run          (GET /evals/:id)
 *   evalguard scans                     — list security scans   (GET /security?projectId)
 *   evalguard scans:get <id>            — one security scan     (GET /security/:id)
 *   evalguard traces                    — list traces           (GET /traces?projectId)
 *   evalguard traces:get <traceId>      — one trace waterfall   (GET /traces/:traceId)
 *   evalguard prompts                   — list prompt versions  (GET /prompts?projectId)
 *   evalguard prompts:get <name>        — one prompt's versions (filtered list)
 *   evalguard scorers                   — list server scorers   (GET /scorers)
 *   evalguard webhooks:list             — list webhooks         (GET /webhooks?orgId)
 *   evalguard webhooks:create <url>     — create webhook        (POST /webhooks)
 *   evalguard webhooks:test <id>        — health-check a webhook (GET /webhooks/deliveries?webhookId)
 *
 * Every fetcher is a pure, dependency-injectable function (`fetchImpl`) so the
 * HTTP contract is unit-testable without a live server — mirrors the pattern
 * used by `cost-export.ts`.
 */
import { Command } from "commander";
import chalk from "chalk";
import {
  resolveApiKey,
  resolveBaseUrl,
  resolveProjectId,
} from "../lib/config.js";
import {
  decodeJsonBody,
  expectArray,
  expectArrayField,
  expectResult,
  timedFetch,
  unwrapApiEnvelope,
} from "../lib/http.js";
import {
  LOOSE_UUID_RE,
  parseCountFlag,
  parseUuidArg,
  requireNonEmptyFlag,
} from "../lib/arg-validate.js";

const UUID_RE = LOOSE_UUID_RE;

/**
 * The row ceilings these routes actually apply, copied from the routes so the
 * CLI refuses exactly what the server would have silently clamped — not a
 * number chosen because it felt safe.
 *
 *   /security   `Math.max(1, Math.min(Number(limit) || 50, 200))`
 *   /prompts    the same expression, same 200
 *   /traces     `Math.min(Number(limit ?? 100), 1000)`
 *   /webhooks/deliveries
 *               `Math.min(Math.max(1, isNaN(raw) ? 50 : raw), 200)`
 *
 * Every one of them CLAMPS rather than errors, which is why `-n 99999999999`
 * used to return a page of rows the operator reads as "that is all there is".
 */
const MAX_ROWS = { security: 200, prompts: 200, traces: 1000, deliveries: 200 } as const;

/**
 * What a silently-dropped `-n` costs, said once. All five list commands did
 * `opts.limit ? parseInt(opts.limit, 10) : undefined` and then `if (limit)`,
 * so `abc` and `0` both became falsy, the flag vanished from the query string,
 * and the route's own default (50 / 100) answered instead — under a header
 * that reads `Security Scans (50)`.
 */
const LIMIT_CONSEQUENCE =
  "The flag would have been dropped and the endpoint's DEFAULT page size would have answered instead.";

/** What an empty `--project` costs. See lib/config.ts#resolveProjectId. */
const PROJECT_CONSEQUENCE =
  "An empty id is not 'unspecified' — the CLI would have silently used the org's DEFAULT project " +
  "and printed ITS rows under the id you thought you passed.";

/**
 * Read `--project` from wherever Commander actually parked it.
 *
 * Found while testing the empty-`--project` refusal, and it is strictly worse
 * than the defect that led here: on `traces get` and `prompts get`, a
 * PERFECTLY VALID `--project` was being discarded outright. Both subcommands
 * declare `--project`, and so does their PARENT (`traces` / `prompts`, the list
 * commands) — and Commander lets a parent option consume a token that appears
 * after the subcommand name. Measured:
 *
 *     traces get <id> --project 0000…a2   → subcommand opts.project === undefined
 *                                           parent opts.project    === "0000…a2"
 *
 * `resolveProjectId(undefined)` then auto-resolved the org's DEFAULT project,
 * so an operator asking for a trace in project B had it looked up in project A
 * — the same cross-project answer as `runs --project ""`, reached by a caller
 * who did everything right.
 *
 * The fix is to LOOK where the value is, rather than to delete the flag: unlike
 * `logs list -n` (a short form that duplicated an unrelated parent flag),
 * `--project` here means the same thing on parent and child, so falling back to
 * the parent's value is exactly what the user meant. The child's own value
 * still wins when Commander does deliver one, so nothing changes for the
 * top-level list commands.
 */
function projectFlag(opts: { project?: string }, cmd: Command): string | undefined {
  if (opts.project !== undefined) return opts.project;
  const parent = cmd.parent as Command | null | undefined;
  return parent ? (parent.opts() as { project?: string }).project : undefined;
}

/** Resolve the API key or print a clear hint and exit. */
function requireApiKey(): string {
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

function requireOrgId(opts: { org?: string }): string {
  const id = opts.org ?? process.env.EVALGUARD_ORG_ID;
  if (!id) {
    console.error(chalk.red("Provide --org <orgId> or set EVALGUARD_ORG_ID."));
    process.exit(1);
  }
  return id;
}

/**
 * Issue a JSON request against the EvalGuard API and unwrap the standard
 * `{ success, data }` envelope. Returns the raw parsed body so callers that
 * need envelope metadata (e.g. nextCursor) can read it. Throws a single-line
 * `HTTP <status>` error (with the server's error code/message when present) on
 * any non-2xx so command actions surface a clean message.
 */
export async function apiRequest(opts: {
  path: string;
  method?: string;
  body?: unknown;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const method = opts.method ?? "GET";
  const res = await timedFetch(
    `${opts.baseUrl}${opts.path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
    { fetchImpl: opts.fetchImpl },
  );

  // FAIL CLOSED. This used to be `await res.json().catch(() => null)`, which
  // turned an unreadable 200 into `null` and let every caller below print its
  // "nothing found" empty state and exit 0 — see lib/http.ts for the measured
  // table.
  const parsed = await decodeJsonBody(res, `${method} ${opts.path}`);
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    const detail = err ? ` (${err.code ?? "ERROR"}: ${err.message ?? "unknown"})` : "";
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return parsed;
}

/**
 * Unwrap a `{ success, data }` envelope, tolerating a raw body.
 *
 * Delegates to the shared contract in `lib/http.ts` (which mirrors the MCP
 * server's) rather than re-deriving one. The previous local version used
 * `"data" in body` — a prototype-chain read — and returned `data` even when it
 * was `null`, which is exactly how `{"success":true,"data":null}` became
 * "No eval runs found for this project." with exit 0.
 */
function unwrap<T = unknown>(body: unknown, endpoint = "the EvalGuard API"): T {
  return unwrapApiEnvelope(body, endpoint) as T;
}

// ─── Typed shapes (best-effort — server is canonical) ────────────────────────

export interface EvalRunSummary {
  id: string;
  name: string;
  model: string;
  status: string;
  score: number | null;
  created_at: string;
  completed_at: string | null;
  duration: number | null;
}

export interface ScanSummary {
  id: string;
  model: string;
  prompt: string;
  status: string;
  attack_types: string[] | null;
  created_at: string;
  completed_at: string | null;
}

export interface TraceSummary {
  traceId: string;
  rootSpanName: string;
  duration: number;
  spanCount: number;
  services: string[];
  status: string;
  startTime: number;
}

export interface PromptVersion {
  id: string;
  name: string;
  version: number;
  content: string;
  variables: string[] | null;
  created_at: string;
}

export interface ServerScorer {
  id: string;
  name: string;
  description: string;
}

export interface WebhookRow {
  id: string;
  org_id: string;
  url: string;
  events: string[];
  enabled: boolean;
  consecutive_failures: number | null;
  created_at: string;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

/** GET /evals?projectId=... → eval run list (apiSuccess array). */
export async function fetchEvalRuns(opts: {
  projectId: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<EvalRunSummary[]> {
  const body = await apiRequest({
    path: `/evals?projectId=${encodeURIComponent(opts.projectId)}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return expectArray(unwrap(body, "GET /evals"), "GET /evals") as EvalRunSummary[];
}

/**
 * The fields that make a body THIS route's answer.
 *
 * ADDED 2026-08-10, after the 28 x 10 fault-mode matrix. The LIST fetchers were
 * closed by `expectArray` in the 2026-08-08 pass; the two single-record
 * fetchers ended at a bare `unwrap<Record<string, unknown>>(body)`, which is an
 * unwrap with no contract — an object is an object. Measured on the built 3.8.0
 * CLI against a stub answering 200 + `{}`:
 *
 *     $ evalguard runs get 33333333-3333-4333-8333-333333333333
 *         Eval run
 *         ID: 33333333-3333-4333-8333-333333333333
 *         Status: —                                    EXIT 0
 *     $ evalguard scans get 33333333-3333-4333-8333-333333333333
 *         Security Scan 33333333
 *         Status: —                                    EXIT 0
 *
 * Nothing on either screen came from the server. The title is the renderer's
 * `?? "Eval run"`, the status is its `?? ""`, and the ID is the one the USER
 * typed, handed back by `run.id ?? id` — so the output looks like a successful
 * lookup of exactly the record that was asked for. `id` + `status` are the two
 * columns both routes always send (they are non-optional on `EvalRunSummary` /
 * `ScanSummary` above), so requiring them distinguishes "this is that record"
 * from "this is some 200".
 */
const RECORD_FIELDS = ["id", "status"] as const;

/** GET /evals/:id → single eval run (apiSuccess object). */
export async function fetchEvalRun(opts: {
  id: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = await apiRequest({
    path: `/evals/${encodeURIComponent(opts.id)}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return expectResult<Record<string, unknown>>(body, "GET /evals/:id", RECORD_FIELDS);
}

/** GET /security?projectId=... → security scan list (apiSuccess array). */
export async function fetchScans(opts: {
  projectId: string;
  limit?: number;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ScanSummary[]> {
  const qs = new URLSearchParams({ projectId: opts.projectId });
  if (opts.limit) qs.set("limit", String(opts.limit));
  const body = await apiRequest({
    path: `/security?${qs.toString()}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return expectArray(unwrap(body, "GET /security"), "GET /security") as ScanSummary[];
}

/** GET /security/:id → single scan (apiSuccess object). */
export async function fetchScan(opts: {
  id: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = await apiRequest({
    path: `/security/${encodeURIComponent(opts.id)}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  // Same contract as `fetchEvalRun`, and this one renders a SECURITY verdict.
  return expectResult<Record<string, unknown>>(body, "GET /security/:id", RECORD_FIELDS);
}

/**
 * GET /traces?projectId=... → trace list. The server wraps the array in an
 * envelope `{ traces, total, source, nextCursor, ... }` INSIDE `data` (unlike
 * /evals which puts the array directly in `data`). We return the inner
 * `traces` array.
 */
export async function fetchTraces(opts: {
  projectId: string;
  limit?: number;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<TraceSummary[]> {
  const qs = new URLSearchParams({ projectId: opts.projectId });
  if (opts.limit) qs.set("limit", String(opts.limit));
  const body = await apiRequest({
    path: `/traces?${qs.toString()}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  // `data?.traces ?? []` here turned a 200 carrying `{"hello":"world"}` into
  // "No traces found for this project." with exit 0 — measured. See
  // expectArrayField in lib/http.ts.
  return expectArrayField(unwrap(body, "GET /traces"), "traces", "GET /traces") as TraceSummary[];
}

/**
 * GET /traces/:traceId?projectId=... → single trace waterfall. The route
 * REQUIRES a UUID-shaped traceId and returns 400 INVALID_ID otherwise, so we
 * pre-validate to fail fast with a clear message.
 */
export async function fetchTrace(opts: {
  traceId: string;
  projectId: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  if (!UUID_RE.test(opts.traceId)) {
    throw new Error(`traceId must be a UUID. Got: ${opts.traceId}`);
  }
  const body = await apiRequest({
    path: `/traces/${encodeURIComponent(opts.traceId)}?projectId=${encodeURIComponent(opts.projectId)}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return unwrap<Record<string, unknown>>(body);
}

/** GET /prompts?projectId=... → prompt version list (apiSuccess array). */
export async function fetchPrompts(opts: {
  projectId: string;
  limit?: number;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PromptVersion[]> {
  const qs = new URLSearchParams({ projectId: opts.projectId });
  if (opts.limit) qs.set("limit", String(opts.limit));
  const body = await apiRequest({
    path: `/prompts?${qs.toString()}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return expectArray(unwrap(body, "GET /prompts"), "GET /prompts") as PromptVersion[];
}

/** GET /scorers → server-side scorer registry. The server wraps an array in
 *  `{ scorers, total }` inside `data`; we return the inner `scorers` array. */
export async function fetchServerScorers(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ServerScorer[]> {
  const body = await apiRequest({
    path: `/scorers`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  // Was `data?.scorers ?? []`, which rendered an unrelated 200 as
  // "Server Scorers (0)" and exited 0.
  return expectArrayField(unwrap(body, "GET /scorers"), "scorers", "GET /scorers") as ServerScorer[];
}

/** GET /webhooks?orgId=... → webhook list (apiSuccess array). */
export async function fetchWebhooks(opts: {
  orgId: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<WebhookRow[]> {
  if (!UUID_RE.test(opts.orgId)) {
    throw new Error(`orgId must be a UUID. Got: ${opts.orgId}`);
  }
  const body = await apiRequest({
    path: `/webhooks?orgId=${encodeURIComponent(opts.orgId)}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return expectArray(unwrap(body, "GET /webhooks"), "GET /webhooks") as WebhookRow[];
}

/**
 * POST /webhooks → create a webhook. The server returns the new row PLUS the
 * raw `secret` ONCE (it is never shown again), so we return the full object.
 */
export async function createWebhook(opts: {
  orgId: string;
  url: string;
  events: string[];
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<WebhookRow & { secret?: string }> {
  if (!UUID_RE.test(opts.orgId)) {
    throw new Error(`orgId must be a UUID. Got: ${opts.orgId}`);
  }
  try {
    // eslint-disable-next-line no-new
    new URL(opts.url);
  } catch {
    throw new Error(`url must be a valid URL. Got: ${opts.url}`);
  }
  if (!opts.events.length) {
    throw new Error("At least one event is required (--event <id>).");
  }
  const body = await apiRequest({
    path: `/webhooks`,
    method: "POST",
    body: { orgId: opts.orgId, url: opts.url, events: opts.events },
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return unwrap<WebhookRow & { secret?: string }>(body);
}

export interface WebhookHealth {
  webhookId: string;
  total: number;
  recent: Array<{ event: string; success: boolean; status_code: number | null; created_at: string }>;
  successRate: number | null;
  lastDeliveryAt: string | null;
}

/**
 * "Test" a webhook by reading its recent delivery history
 * (GET /webhooks/deliveries?webhookId=...) and computing a health summary.
 * EvalGuard does not expose a synchronous "ping this webhook" endpoint, so the
 * honest, read-only health check is the delivery log: an operator can see
 * whether deliveries are succeeding without mutating anything.
 */
export async function testWebhook(opts: {
  webhookId: string;
  limit?: number;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<WebhookHealth> {
  if (!UUID_RE.test(opts.webhookId)) {
    throw new Error(`webhookId must be a UUID. Got: ${opts.webhookId}`);
  }
  const limit = opts.limit ?? 20;
  const body = await apiRequest({
    path: `/webhooks/deliveries?webhookId=${encodeURIComponent(opts.webhookId)}&limit=${limit}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  const data = unwrap(body, "GET /webhooks/deliveries");
  // `data?.deliveries ?? []` reported an unreadable response as "0 deliveries,
  // 100% success" — a health figure computed from a body nobody could read.
  const deliveries = expectArrayField(
    data,
    "deliveries",
    "GET /webhooks/deliveries",
  ) as Array<{ event: string; success: boolean; status_code: number | null; created_at: string }>;
  const successCount = deliveries.filter((d) => d.success).length;
  return {
    webhookId: opts.webhookId,
    total: (data as { total?: number })?.total ?? deliveries.length,
    recent: deliveries,
    successRate: deliveries.length ? successCount / deliveries.length : null,
    lastDeliveryAt: deliveries[0]?.created_at ?? null,
  };
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function statusColor(status: string): (s: string) => string {
  const s = status.toLowerCase();
  if (s === "passed" || s === "completed" || s === "ok") return chalk.green;
  if (s === "failed" || s === "error") return chalk.red;
  if (s === "running" || s === "pending") return chalk.yellow;
  return chalk.dim;
}

function fmtDate(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerServerRead(program: Command): void {
  // ─── runs (eval runs) ───
  const runs = program
    .command("runs")
    .description("List eval runs stored on the EvalGuard server (GET /evals)")
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project?: string; json?: boolean }) => {
      const project = requireNonEmptyFlag(opts.project, "--project", PROJECT_CONSEQUENCE);
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);
      const rows = await fetchEvalRuns({ projectId, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim("\n  No eval runs found for this project.\n"));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Eval Runs (${rows.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));
      for (const r of rows) {
        const color = statusColor(r.status ?? "");
        console.log(
          `  ${color("●")} ${chalk.bold((r.name ?? "—").slice(0, 30).padEnd(30))} ${color((r.status ?? "—").padEnd(10))} ${chalk.dim((r.model ?? "—").padEnd(18))} ${chalk.dim(r.id.slice(0, 8))} ${chalk.dim(fmtDate(r.created_at))}`,
        );
      }
      console.log();
    });

  runs
    .command("get <id>")
    .description("Show a single eval run (GET /evals/:id)")
    .option("--json", "Output as JSON", false)
    .action(async (rawId: string, opts: { json?: boolean }) => {
      // Its siblings `traces get`, `webhooks test` and `decision-bom verify`
      // all validate their id; these two did not. The id is
      // `encodeURIComponent`-ed before it reaches the URL, so
      // `runs get ../../scorers` was never a traversal — it was a round trip
      // spent rendering a 404 that a local check answers instantly.
      const id = parseUuidArg(
        rawId,
        "eval run id",
        "The request would have gone out anyway and come back 404 — this is the same check `traces get` already does.",
      );
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const run = await fetchEvalRun({ id, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  ${String(run.name ?? "Eval run")}`));
      console.log(chalk.dim(`  ID: ${String(run.id ?? id)}`));
      const status = String(run.status ?? "");
      console.log(`  Status: ${statusColor(status)(status || "—")}`);
      if (run.model) console.log(chalk.dim(`  Model: ${String(run.model)}`));
      if (run.score != null) console.log(`  Score: ${chalk.bold(String(run.score))}`);
      console.log();
    });

  // ─── scans (security scans) ───
  const scans = program
    .command("scans")
    .description("List security scans stored on the EvalGuard server (GET /security)")
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("-n, --limit <number>", "Max scans to show", "50")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project?: string; limit?: string; json?: boolean }) => {
      const project = requireNonEmptyFlag(opts.project, "--project", PROJECT_CONSEQUENCE);
      const limit = parseCountFlag(opts.limit, "-n, --limit", {
        max: MAX_ROWS.security,
        consequence: LIMIT_CONSEQUENCE,
      });
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);
      const rows = await fetchScans({ projectId, limit, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim("\n  No security scans found for this project.\n"));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Security Scans (${rows.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));
      for (const s of rows) {
        const color = statusColor(s.status ?? "");
        const attacks = Array.isArray(s.attack_types) ? `${s.attack_types.length} attack types` : "—";
        console.log(
          `  ${color("●")} ${color((s.status ?? "—").padEnd(10))} ${chalk.dim((s.model ?? "—").padEnd(18))} ${chalk.dim(attacks.padEnd(18))} ${chalk.dim(s.id.slice(0, 8))} ${chalk.dim(fmtDate(s.created_at))}`,
        );
      }
      console.log();
    });

  scans
    .command("get <id>")
    .description("Show a single security scan (GET /security/:id)")
    .option("--json", "Output as JSON", false)
    .action(async (rawId: string, opts: { json?: boolean }) => {
      const id = parseUuidArg(
        rawId,
        "security scan id",
        "The request would have gone out anyway and come back 404 — and this one renders a SECURITY verdict.",
      );
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const scan = await fetchScan({ id, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(scan, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Security Scan ${String(scan.id ?? id).slice(0, 8)}`));
      const status = String(scan.status ?? "");
      console.log(`  Status: ${statusColor(status)(status || "—")}`);
      if (scan.model) console.log(chalk.dim(`  Model: ${String(scan.model)}`));
      console.log();
    });

  // ─── traces ───
  const traces = program
    .command("traces")
    .description("List traces stored on the EvalGuard server (GET /traces)")
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("-n, --limit <number>", "Max traces to show", "50")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project?: string; limit?: string; json?: boolean }) => {
      const project = requireNonEmptyFlag(opts.project, "--project", PROJECT_CONSEQUENCE);
      const limit = parseCountFlag(opts.limit, "-n, --limit", {
        max: MAX_ROWS.traces,
        consequence: LIMIT_CONSEQUENCE,
      });
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);
      const rows = await fetchTraces({ projectId, limit, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim("\n  No traces found for this project.\n"));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Traces (${rows.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));
      for (const t of rows) {
        const color = statusColor(t.status ?? "");
        console.log(
          `  ${color("●")} ${chalk.bold((t.rootSpanName ?? "—").slice(0, 28).padEnd(28))} ${chalk.dim(`${t.spanCount} spans`.padEnd(10))} ${chalk.dim(`${t.duration}ms`.padEnd(10))} ${chalk.dim(t.traceId.slice(0, 12))} ${chalk.dim(fmtDate(t.startTime))}`,
        );
      }
      console.log();
    });

  traces
    .command("get <traceId>")
    .description("Show a single trace waterfall (GET /traces/:traceId)")
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("--json", "Output as JSON", false)
    .action(async (traceId: string, opts: { project?: string; json?: boolean }, cmd: Command) => {
      const project = requireNonEmptyFlag(projectFlag(opts, cmd), "--project", PROJECT_CONSEQUENCE);
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);
      const trace = await fetchTrace({ traceId, projectId, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(trace, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Trace ${String(trace.traceId ?? traceId)}`));
      const status = String(trace.status ?? "");
      console.log(`  Status: ${statusColor(status)(status || "—")}`);
      if (trace.rootSpanName) console.log(chalk.dim(`  Root: ${String(trace.rootSpanName)}`));
      if (trace.spanCount != null) console.log(chalk.dim(`  Spans: ${String(trace.spanCount)}`));
      if (trace.totalDuration != null) console.log(chalk.dim(`  Duration: ${String(trace.totalDuration)}ms`));
      const waterfall = Array.isArray(trace.waterfall) ? (trace.waterfall as Array<Record<string, unknown>>) : [];
      if (waterfall.length > 0) {
        console.log();
        console.log(chalk.dim("  Waterfall:"));
        for (const span of waterfall) {
          const depth = Number(span.depth ?? 0);
          const indent = "  " + "  ".repeat(depth);
          console.log(
            `${indent}${chalk.cyan(String(span.name ?? "—"))} ${chalk.dim(`${span.duration ?? "?"}ms`)}`,
          );
        }
      }
      console.log();
    });

  // ─── prompts ───
  const prompts = program
    .command("prompts")
    .description("List prompt versions stored on the EvalGuard server (GET /prompts)")
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("-n, --limit <number>", "Max versions to show", "50")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project?: string; limit?: string; json?: boolean }) => {
      const project = requireNonEmptyFlag(opts.project, "--project", PROJECT_CONSEQUENCE);
      const limit = parseCountFlag(opts.limit, "-n, --limit", {
        max: MAX_ROWS.prompts,
        consequence: LIMIT_CONSEQUENCE,
      });
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);
      const rows = await fetchPrompts({ projectId, limit, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim("\n  No prompts found for this project.\n"));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Prompt Versions (${rows.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));
      for (const p of rows) {
        console.log(
          `  ${chalk.cyan((p.name ?? "—").padEnd(28))} ${chalk.dim(`v${p.version}`.padEnd(6))} ${chalk.dim(p.id.slice(0, 8))} ${chalk.dim(fmtDate(p.created_at))}`,
        );
      }
      console.log();
    });

  prompts
    .command("get <name>")
    .description("Show all versions of a named prompt (GET /prompts filtered by name)")
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("--json", "Output as JSON", false)
    .action(async (name: string, opts: { project?: string; json?: boolean }, cmd: Command) => {
      const project = requireNonEmptyFlag(projectFlag(opts, cmd), "--project", PROJECT_CONSEQUENCE);
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);
      // The server has no /prompts/:name route; list the project's versions and
      // filter to the requested name (versions descending in the API response).
      const all = await fetchPrompts({ projectId, limit: 200, baseUrl, apiKey });
      const matches = all.filter((p) => p.name === name);
      if (opts.json) {
        console.log(JSON.stringify(matches, null, 2));
        return;
      }
      if (matches.length === 0) {
        console.log(chalk.dim(`\n  No prompt named "${name}" found in this project.\n`));
        return;
      }
      console.log();
      console.log(chalk.bold(`  ${name} (${matches.length} version${matches.length === 1 ? "" : "s"})`));
      for (const p of matches) {
        console.log();
        console.log(`  ${chalk.cyan(`v${p.version}`)} ${chalk.dim(p.id.slice(0, 8))} ${chalk.dim(fmtDate(p.created_at))}`);
        if (p.variables && p.variables.length > 0) {
          console.log(chalk.dim(`    variables: ${p.variables.join(", ")}`));
        }
        console.log(chalk.dim("    " + (p.content ?? "").slice(0, 200).replace(/\n/g, " ")));
      }
      console.log();
    });

  // ─── scorers (server registry) ───
  program
    .command("scorers")
    .description("List scorers the EvalGuard server exposes (GET /scorers)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const rows = await fetchServerScorers({ baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Server Scorers (${rows.length})`));
      console.log();
      for (const s of rows) {
        console.log(`  ${chalk.cyan((s.id ?? s.name).padEnd(25))} ${chalk.dim(s.description ?? "")}`);
      }
      console.log();
    });

  // ─── webhooks ───
  const webhooks = program
    .command("webhooks")
    .description("Manage org webhooks on the EvalGuard server");

  webhooks
    .command("list")
    .description("List webhooks in your org (GET /webhooks)")
    .option("--org <orgId>", "Organization ID (or set EVALGUARD_ORG_ID)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org?: string; json?: boolean }) => {
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const orgId = requireOrgId(opts);
      const rows = await fetchWebhooks({ orgId, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim("\n  No webhooks registered for this org.\n"));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Webhooks (${rows.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));
      for (const w of rows) {
        const state = w.enabled ? chalk.green("enabled") : chalk.dim("disabled");
        const fails = w.consecutive_failures ? chalk.red(`${w.consecutive_failures} fails`) : chalk.dim("healthy");
        console.log(
          `  ${chalk.cyan(w.id.slice(0, 8))} ${state.padEnd(18)} ${fails.padEnd(18)} ${chalk.dim((w.events ?? []).join(","))}`,
        );
        console.log(`     ${chalk.dim(w.url)}`);
      }
      console.log();
    });

  webhooks
    .command("create <url>")
    .description("Create a webhook (POST /webhooks). Prints the signing secret ONCE.")
    .requiredOption("--event <id...>", "Event(s) to subscribe to (repeatable). See `webhooks events` catalog.")
    .option("--org <orgId>", "Organization ID (or set EVALGUARD_ORG_ID)")
    .option("--json", "Output as JSON", false)
    .action(async (url: string, opts: { event: string[]; org?: string; json?: boolean }) => {
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const orgId = requireOrgId(opts);
      const created = await createWebhook({ orgId, url, events: opts.event, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
        return;
      }
      console.log();
      console.log(chalk.green(`✓ Webhook created: ${created.id}`));
      console.log(chalk.dim(`  URL: ${created.url}`));
      console.log(chalk.dim(`  Events: ${(created.events ?? opts.event).join(", ")}`));
      if (created.secret) {
        console.log();
        console.log(chalk.yellow("  Signing secret (shown ONCE — store it now):"));
        console.log(`  ${chalk.bold(created.secret)}`);
        console.log(chalk.dim("  Verify deliveries with HMAC-SHA256 over `${timestamp}.${body}`."));
      }
      console.log();
    });

  webhooks
    .command("test <id>")
    .description("Health-check a webhook by reading its recent deliveries (GET /webhooks/deliveries)")
    .option("-n, --limit <number>", "Recent deliveries to inspect", "20")
    .option("--json", "Output as JSON", false)
    .action(async (id: string, opts: { limit?: string; json?: boolean }) => {
      // `testWebhook` already validates the id; the limit did NOT — and here a
      // NaN was not even dropped, it was interpolated: the request went out as
      // `…&limit=NaN`, which the route reads as isNaN → 50, so the health
      // summary covered a different number of deliveries than was asked for.
      const limit = parseCountFlag(opts.limit, "-n, --limit", {
        max: MAX_ROWS.deliveries,
        consequence: "The request would have gone out as `limit=NaN` and the route would have used 50.",
      });
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const health = await testWebhook({ webhookId: id, limit, baseUrl, apiKey });
      if (opts.json) {
        console.log(JSON.stringify(health, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Webhook ${id.slice(0, 8)} delivery health`));
      console.log(chalk.dim("  " + "-".repeat(60)));
      if (health.recent.length === 0) {
        console.log(
          chalk.dim(
            "  No deliveries yet. Trigger an eval/scan that emits a subscribed event, then re-run.",
          ),
        );
        console.log();
        return;
      }
      const rate = health.successRate != null ? `${(health.successRate * 100).toFixed(0)}%` : "—";
      const rateColor = (health.successRate ?? 0) >= 0.8 ? chalk.green : (health.successRate ?? 0) >= 0.5 ? chalk.yellow : chalk.red;
      console.log(`  Success rate (recent): ${rateColor(rate)}  (${health.total} total deliveries)`);
      console.log(`  Last delivery: ${chalk.dim(fmtDate(health.lastDeliveryAt))}`);
      console.log();
      for (const d of health.recent) {
        const icon = d.success ? chalk.green("✓") : chalk.red("✗");
        console.log(
          `  ${icon} ${(d.event ?? "—").padEnd(28)} ${chalk.dim(String(d.status_code ?? "—").padEnd(5))} ${chalk.dim(fmtDate(d.created_at))}`,
        );
      }
      console.log();
    });
}
