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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}${opts.path}`, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    const detail = err ? ` (${err.code ?? "ERROR"}: ${err.message ?? "unknown"})` : "";
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return parsed;
}

/** Unwrap a `{ success, data }` envelope, tolerating a raw body. */
function unwrap<T = unknown>(body: unknown): T {
  if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
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
  return unwrap<EvalRunSummary[]>(body) ?? [];
}

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
  return unwrap<Record<string, unknown>>(body);
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
  return unwrap<ScanSummary[]>(body) ?? [];
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
  return unwrap<Record<string, unknown>>(body);
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
  const data = unwrap<{ traces?: TraceSummary[] }>(body);
  return data?.traces ?? [];
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
  return unwrap<PromptVersion[]>(body) ?? [];
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
  const data = unwrap<{ scorers?: ServerScorer[] }>(body);
  return data?.scorers ?? [];
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
  return unwrap<WebhookRow[]>(body) ?? [];
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
  const data = unwrap<{
    deliveries?: Array<{ event: string; success: boolean; status_code: number | null; created_at: string }>;
    total?: number;
  }>(body);
  const deliveries = data?.deliveries ?? [];
  const successCount = deliveries.filter((d) => d.success).length;
  return {
    webhookId: opts.webhookId,
    total: data?.total ?? deliveries.length,
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
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(opts.project);
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
    .action(async (id: string, opts: { json?: boolean }) => {
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
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(opts.project);
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
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
    .action(async (id: string, opts: { json?: boolean }) => {
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
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(opts.project);
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
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
    .action(async (traceId: string, opts: { project?: string; json?: boolean }) => {
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(opts.project);
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
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(opts.project);
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
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
    .action(async (name: string, opts: { project?: string; json?: boolean }) => {
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(opts.project);
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
      const apiKey = requireApiKey();
      const baseUrl = resolveBaseUrl();
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
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
