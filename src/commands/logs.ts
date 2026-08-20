/**
 * `evalguard logs` — View recent eval/scan run logs
 *
 * Two surfaces:
 *   • `evalguard logs`        — tail local run logs from ~/.evalguard (offline).
 *   • `evalguard logs list`   — server-side production-log records filtered by
 *                               search / metadata-search / date-range / sample,
 *                               with a gated `--raw` view of the redacted
 *                               provider request/response.
 *
 * The `list` subcommand mirrors the Phase-1/2 server-read command style: pure,
 * dependency-injectable fetchers (`fetchImpl`) so the HTTP contract is
 * unit-testable without a live server, and the filter/redaction semantics come
 * straight from `@evalguard/core` (`filterLogs`, `redactRawCapture`) so the CLI,
 * the server, and the observability dashboard stay in lock-step.
 *
 * ── THIS COMMAND CALLED AN ENDPOINT THAT DOES NOT EXIST (2026-08-10) ────────
 *
 * `logs list` shipped in `6879c5d64` (PR #1012, 2026-07-08) calling `GET /logs`
 * — the URL Humanloop's logs.list() uses, with Humanloop's parameter
 * vocabulary. `apps/web` never implemented that path. Measured against a served
 * build, the exact request this command sent:
 *
 *     GET /api/v1/logs?projectId=…&search=…&metadata_search=…&start_date=…
 *         &end_date=…&limit=100&include_raw=true
 *     -> HTTP 404  {"error":"Not found"}
 *
 * byte-identical to `GET /api/v1/definitely-not-a-route-xyz`, because both land
 * on `apps/web/src/app/api/v1/[...catch]/route.ts`. Controls in the same run:
 * `/api/v1/monitoring` and `/api/v1/audit-logs` answered 401 INVALID_API_KEY
 * and `/api/health` answered 200 — the server was routing, not blanket-404ing.
 *
 * Provenance: the route was never RETIRED, it never existed.
 * `git log --all --diff-filter=ADR -- 'apps/web/src/app/api/v1/logs/**'` is
 * empty, and `changelog.json` has no `/logs` entry. So this is not a page that
 * was deliberately removed and should stay removed — it is a call that was
 * never wired.
 *
 * ── WHY THIS REPOINTS AT `GET /monitoring`, AND NOT AT `audit-logs` ─────────
 *
 * The tempting repoint is `/api/v1/audit-logs`, because the name is close. That
 * would be the worst outcome available: audit-logs is the WHO-DID-WHAT trail
 * (actor, action, resource — the table `writeAuditLog` writes to). It has no
 * inputs, no output, no model, no provider payloads. The command would start
 * succeeding while answering a different question, which is strictly worse than
 * a 404 an operator can see.
 *
 * `GET /api/v1/monitoring` is not a near-name — it is the same data:
 *
 *   • same table.   Both read `production_logs`. The raw-capture columns this
 *     command's `--raw` renders (`stdout`, `provider_request`,
 *     `provider_response`) were added to `production_logs` by
 *     supabase/migrations/20260721_hl_observability_raw_capture_valence.sql,
 *     whose own header says they are "read-gated behind an owner/admin
 *     captureRaw view" — that read API is this route.
 *   • same filter.  The route calls `filterLogs` from `@evalguard/core` — the
 *     identical function this file imports — with the identical
 *     `{search, metadataSearch, startDate, endDate, sample}` LogFilter.
 *   • same policy.  `--raw` maps to the route's `captureRaw`, which is opt-in
 *     AND restricted to org owner/admin, then re-redacted by the same core
 *     `redactRawCapture` this file calls defensively.
 *
 * What changed here is therefore only the spelling of the request: the path,
 * four query-parameter names, and the envelope field the rows arrive in.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  filterLogs,
  redactRawCapture,
  type LogFilter,
  type FilterableLog,
  type RawProviderCapture,
} from "@evalguard/core";
import { resolveApiKey, resolveBaseUrl, resolveProjectId } from "../lib/config.js";
import { apiRequest } from "./server-read.js";
import { expectArrayField, unwrapApiEnvelope } from "../lib/http.js";
import {
  assertChronological,
  parseCountFlag,
  parseIsoDateFlag,
  parseNonNegativeIntFlag,
  requireNonEmptyFlag,
} from "../lib/arg-validate.js";

/**
 * `--limit` ceiling for `logs list`.
 *
 * This used to be 10_000 — "far past any interactive use" — chosen because the
 * endpoint it was guarding did not exist, so there was no server cap to copy.
 * There is one now: `apps/web/src/app/api/v1/monitoring/route.ts` clamps with
 * `Math.min(Math.max(1, limit), MAX_PAGE_SIZE)` where `MAX_PAGE_SIZE = 1000`.
 *
 * A clamp is silent. `--limit 5000` would have come back with 1000 rows under a
 * header reading `Logs (1000)`, which an operator reads as "that is all there
 * is" — the exact defect already fixed for `/security`, `/prompts`, `/traces`
 * and `/webhooks/deliveries` in server-read.ts. Refuse what the server would
 * have quietly truncated.
 */
const MAX_LOG_ROWS = 1_000;

const LOG_DIR = path.join(os.homedir(), ".evalguard", "logs");

function getLogFiles(type?: string): string[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));
  if (type) {
    return files.filter((f) => f.startsWith(type));
  }
  return files;
}

function tailFile(filePath: string, lines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  return allLines.slice(-lines);
}

function formatLogLine(line: string): string {
  if (!line.trim()) return "";
  // Colorize log levels
  if (line.includes("[ERROR]") || line.includes("[FAIL]")) {
    return chalk.red(line);
  }
  if (line.includes("[WARN]")) {
    return chalk.yellow(line);
  }
  if (line.includes("[PASS]") || line.includes("[OK]")) {
    return chalk.green(line);
  }
  if (line.includes("[INFO]")) {
    return chalk.dim(line);
  }
  return line;
}

// ─── `logs list` — server-side log records ──────────────────────────────

/**
 * A server-persisted log record — one `production_logs` row. Extends
 * {@link FilterableLog} (the shape the core `filterLogs` reads) with identity +
 * provider-round-trip fields. The raw capture fields (`stdout`,
 * `providerRequest`, `providerResponse`) are only populated when the caller
 * asked for raw capture AND is authorized to see it — otherwise the route
 * strips those columns from the row entirely.
 */
export interface LogRecord extends FilterableLog {
  id: string;
  model?: string | null;
  status?: string | null;
  /** Captured log/debug statements (`stdout`). Present only under `--raw`. */
  stdout?: string;
  /** Raw request sent to provider (`provider_request`). Gated by `--raw`. */
  providerRequest?: Record<string, unknown>;
  /** Raw response received from provider (`provider_response`). Gated. */
  providerResponse?: Record<string, unknown>;
}

/** Options accepted by {@link fetchLogs} — server log-list query params. */
export interface FetchLogsOptions {
  projectId: string;
  /** `search` — substring across input + output. */
  search?: string;
  /** `metadataSearch` — substring across metadata. */
  metadataSearch?: string;
  /** `startDate` — only logs created STRICTLY after this instant. */
  startDate?: Date;
  /** `endDate` — only logs created STRICTLY before this instant. */
  endDate?: Date;
  /** Max rows to pull from the server before client-side refine. */
  limit?: number;
  /**
   * When true, request the raw provider request/response payloads. The server
   * only returns them when the project has opted into raw capture; the CLI
   * re-redacts defensively before display.
   */
  includeRaw?: boolean;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Build the `GET /monitoring` query string.
 *
 * The parameter NAMES are read off the handler
 * (apps/web/src/app/api/v1/monitoring/route.ts, `params.get(...)`), not off the
 * upstream API this feature was modelled on. The four that differ are exactly
 * the ones this command used to get wrong, and an unrecognised query parameter
 * is silently ignored by the route — so each of these would have widened the
 * result set instead of erroring:
 *
 *     metadata_search -> metadataSearch
 *     start_date      -> startDate
 *     end_date        -> endDate
 *     include_raw     -> captureRaw
 *
 * `sample` is deliberately still NOT sent. The route applies it server-side and
 * so does {@link buildLogFilter} client-side; sending it would sample a sample.
 */
export function buildLogsQuery(opts: FetchLogsOptions): string {
  const qs = new URLSearchParams();
  qs.set("projectId", opts.projectId);
  if (opts.search) qs.set("search", opts.search);
  if (opts.metadataSearch) qs.set("metadataSearch", opts.metadataSearch);
  if (opts.startDate) qs.set("startDate", opts.startDate.toISOString());
  if (opts.endDate) qs.set("endDate", opts.endDate.toISOString());
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.includeRaw) qs.set("captureRaw", "true");
  return qs.toString();
}

/**
 * Coerce an arbitrary server row (snake_ or camelCase) into a {@link LogRecord}.
 *
 * TWO MAPPINGS EARN THEIR KEEP, and both are why "just change the URL" would
 * have been a broken repoint. `production_logs` (00000_combined_schema.sql:501)
 * spells the prompt column `input` — singular, TEXT — and has no `status`
 * column at all:
 *
 *   `input` -> `inputs`
 *       The route feeds core `filterLogs` a view with
 *       `inputs: r.input != null ? { input: r.input } : undefined` and then
 *       DELETES that alias before responding (monitoring/route.ts). Reading
 *       only `row.inputs` here leaves every record's `inputs` null, so the
 *       CLIENT-side re-filter would drop exactly the rows the SERVER matched on
 *       the prompt text — `--search` would quietly return fewer rows than
 *       matched, with no error. The alias is rebuilt identically so both sides
 *       filter the same bytes.
 *
 *   `flagged` -> `status`
 *       There is no `status`; there is a guardrail `flagged` boolean. Without
 *       this the status column renders "—" on every row forever. `flagged` is
 *       reported as itself, never dressed up as a run outcome.
 */
export function toLogRecord(row: Record<string, unknown>, includeRaw: boolean): LogRecord {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

  const inputs =
    asRecord(row.inputs) ?? (typeof row.input === "string" ? { input: row.input } : null);
  const status =
    asString(row.status) ??
    (typeof row.flagged === "boolean" ? (row.flagged ? "flagged" : "ok") : null);

  const rec: LogRecord = {
    id: String(row.id ?? row.log_id ?? row.logId ?? ""),
    inputs,
    output: asString(row.output),
    messages: row.messages,
    metadata: asRecord(row.metadata),
    createdAt:
      (row.createdAt as string | number | Date | null | undefined) ??
      (row.created_at as string | number | Date | null | undefined) ??
      null,
    model: asString(row.model),
    status,
  };

  // SECURITY: never carry raw provider payloads unless explicitly requested.
  if (includeRaw) {
    const stdout = asString(row.stdout);
    if (stdout !== null) rec.stdout = stdout;
    const req = asRecord(row.providerRequest) ?? asRecord(row.provider_request);
    if (req) rec.providerRequest = req;
    const res = asRecord(row.providerResponse) ?? asRecord(row.provider_response);
    if (res) rec.providerResponse = res;
  }

  return rec;
}

/** The endpoint label used in every error this module raises. */
const LOGS_ENDPOINT = "GET /monitoring";

/** One page of production logs, plus whether the server actually served raw capture. */
export interface LogPage {
  records: LogRecord[];
  /**
   * The route's `rawCaptureVisible`. FALSE means the raw provider columns were
   * stripped before the response was built — either `--raw` was not requested,
   * or the caller is not an org owner/admin. Absent on the empty-table
   * fail-soft path, which is why this is optional rather than defaulted true.
   */
  rawCaptureVisible?: boolean;
}

/**
 * Fetch a page of production logs from the EvalGuard server
 * (`GET /monitoring`). Pure + injectable (`fetchImpl`) per the server-read
 * pattern.
 */
export async function fetchLogPage(opts: FetchLogsOptions): Promise<LogPage> {
  const body = await apiRequest({
    path: `/monitoring?${buildLogsQuery(opts)}`,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  const data = unwrapApiEnvelope(body, LOGS_ENDPOINT);
  // The trailing `: []` was the fail-open. Measured on the built CLI,
  // `evalguard logs list --project <id>` printed "No logs match this filter."
  // and exited 0 against a 200 carrying `{"hello":"world"}`,
  // `{"success":true,"data":null}`, `{"success":true,"data":{}}` and an explicit
  // `{"success":false,"error":{…}}` — a definitive "your project logged nothing"
  // produced from a body that never mentioned logs.
  //
  // This handler has exactly ONE success shape: `apiSuccess({ …, recentLogs })`,
  // on every path including the "production_logs does not exist yet" fail-soft.
  // The old code also accepted a bare array and a `{ logs: [...] }` envelope —
  // shapes invented for an endpoint that did not exist. Tolerating a body the
  // route cannot send is not robustness; it is a second way to read an
  // unrecognised 200 as "no logs".
  const rows: unknown[] = expectArrayField(data, "recentLogs", LOGS_ENDPOINT);
  const rawCaptureVisible = (data as { rawCaptureVisible?: unknown }).rawCaptureVisible;
  return {
    records: rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => toLogRecord(r, opts.includeRaw ?? false)),
    rawCaptureVisible: typeof rawCaptureVisible === "boolean" ? rawCaptureVisible : undefined,
  };
}

/** {@link fetchLogPage}, records only — the shape most callers want. */
export async function fetchLogs(opts: FetchLogsOptions): Promise<LogRecord[]> {
  return (await fetchLogPage(opts)).records;
}

/**
 * Translate parsed CLI options into the core {@link LogFilter}. `sample` is
 * included here so the deterministic core `filterLogs` performs the sampling.
 */
export function buildLogFilter(opts: {
  search?: string;
  metadataSearch?: string;
  startDate?: Date;
  endDate?: Date;
  sample?: number;
}): LogFilter {
  const filter: LogFilter = {};
  if (opts.search) filter.search = opts.search;
  if (opts.metadataSearch) filter.metadataSearch = opts.metadataSearch;
  if (opts.startDate) filter.startDate = opts.startDate;
  if (opts.endDate) filter.endDate = opts.endDate;
  if (opts.sample !== undefined) filter.sample = opts.sample;
  return filter;
}

/**
 * Parse a `--since`/`--until` value into a Date, throwing on garbage.
 *
 * KEPT as a pure, throwing function: it is exported, unit-tested, and useful to
 * anything that wants the parse without the process-level policy. The COMMAND
 * goes through `parseIsoDateFlag` (lib/arg-validate.ts) instead, so a bad flag
 * refuses with exit 2 like every other flag in the CLI rather than exit 1 —
 * these two were already validated, and the gap being closed here is the
 * INCONSISTENCY, not the absence.
 */
export function parseDateFlag(value: string | undefined, flag: string): Date | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${flag} must be an ISO date/time. Got: ${value}`);
  }
  return new Date(ms);
}

/** Parse a `--sample` value into a non-negative integer, throwing on garbage. See above. */
export function parseSampleFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--sample must be a non-negative integer. Got: ${value}`);
  }
  return n;
}

/**
 * Redact a log record's raw provider capture for display (belt-and-suspenders
 * over the server-side redaction). Returns a fresh capture — never mutates.
 */
export function redactLogRecordRaw(record: LogRecord): RawProviderCapture {
  const capture: RawProviderCapture = {};
  if (record.stdout !== undefined) capture.stdout = record.stdout;
  if (record.providerRequest !== undefined) capture.providerRequest = record.providerRequest;
  if (record.providerResponse !== undefined) capture.providerResponse = record.providerResponse;
  return redactRawCapture(capture).capture;
}

function snippet(record: LogRecord): string {
  const out = typeof record.output === "string" ? record.output : "";
  const inp = record.inputs ? JSON.stringify(record.inputs) : "";
  const text = (out || inp).replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function logStatusColor(status: string | null | undefined): (s: string) => string {
  const s = (status ?? "").toLowerCase();
  if (s === "success" || s === "ok" || s === "completed") return chalk.green;
  if (s === "error" || s === "failed") return chalk.red;
  // `flagged` is a guardrail verdict on the log, not a run outcome — yellow,
  // deliberately not red: the request succeeded, a guardrail objected to it.
  if (s === "running" || s === "pending" || s === "flagged") return chalk.yellow;
  return chalk.dim;
}

function fmtLogDate(value: Date | string | number | null | undefined): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

interface LogsListOpts {
  project?: string;
  search?: string;
  metadata?: string;
  since?: string;
  until?: string;
  sample?: string;
  limit?: string;
  raw?: boolean;
  json?: boolean;
}

function requireLogsApiKey(): string {
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

function registerLogsList(logsCmd: Command): void {
  logsCmd
    .command("list")
    .description(
      "List server log records: filter by search, metadata, date-range and sample",
    )
    .option("--project <projectId>", "Project ID (defaults to your org's current project)")
    .option("--search <text>", "Only logs whose input/output contain this string")
    .option("--metadata <text>", "Only logs whose metadata contains this string")
    .option("--since <date>", "Only logs created AFTER this ISO date/time (exclusive)")
    .option("--until <date>", "Only logs created BEFORE this ISO date/time (exclusive)")
    .option("--sample <n>", "Randomly sample N logs from the filtered results")
    // `--limit` ONLY — the `-n` short form is deliberately gone.
    //
    // Found while validating the flag, and it is the same defect one level up:
    // the PARENT `logs` command declares `-n, --lines <n>` (the local tail), and
    // Commander lets a parent option consume a token that appears after the
    // subcommand name. So `-n` never reached this action at all. Measured:
    //
    //     logs list -n 7        → opts.limit === "100"   (the default!)
    //     logs list --limit 7   → opts.limit === "7"
    //
    // Removing the short form regresses nobody, because `-n` here has never
    // once been honoured — it silently returned the default page size. Keeping
    // it while ADDING validation would have been worse than leaving it alone:
    // the validator would have been dead code guarding a flag that cannot
    // arrive, i.e. a check that passes because it never runs.
    .option("--limit <number>", "Max rows to pull from the server (use `--limit`; `-n` belongs to `logs`)", "100")
    .option("--raw", "Show the REDACTED raw provider request/response (gated, opt-in)", false)
    .option("--json", "Output as JSON", false)
    .action(async (opts: LogsListOpts) => {
      // ─── Validate EVERY flag before the first byte leaves the process ─────
      //
      // This block used to sit AFTER `resolveProjectId`, which is a network
      // call — so a typo'd date cost a round trip before it was reported. More
      // importantly, three of these were not checked at all:
      //
      //   --project ""                        → the org's default project's logs
      //   -n abc / -n 0                       → the flag vanished; 100 rows came back
      //   --since 2026-08-09 --until 2026-08-01
      //                                       → "No logs match this filter." EXIT 0
      //
      // That last one is the whole audit in one line: an INVERTED RANGE reading
      // as a clean result. `filterLogs` correctly returns nothing for a window
      // that ends before it starts, and the renderer spells nothing as
      // reassurance. Nobody asked "are there logs between the 9th and the 1st";
      // they typo'd, and the CLI answered a question that has no answer.
      const project = requireNonEmptyFlag(
        opts.project,
        "--project",
        "An empty id is not 'unspecified' — the CLI would have listed the org's DEFAULT project's logs.",
      );
      const startDate = parseIsoDateFlag(
        opts.since,
        "--since",
        "The filter would have been dropped and every log would have matched.",
      );
      const endDate = parseIsoDateFlag(
        opts.until,
        "--until",
        "The filter would have been dropped and every log would have matched.",
      );
      assertChronological(
        startDate,
        endDate,
        "--since",
        "--until",
        "A window that ends before it starts matches nothing, and the CLI prints that as " +
          '"No logs match this filter." with exit 0 — indistinguishable from a clean project.',
      );
      const sample = parseNonNegativeIntFlag(
        opts.sample,
        "--sample",
        "The sample would have been dropped and the FULL filtered set would have printed.",
      );
      const limit = parseCountFlag(opts.limit, "--limit", {
        max: MAX_LOG_ROWS,
        consequence:
          "The flag would have been dropped and the default page size would have answered instead.",
      });

      const apiKey = requireLogsApiKey();
      const baseUrl = resolveBaseUrl();
      const projectId = await resolveProjectId(project);

      const { records, rawCaptureVisible } = await fetchLogPage({
        projectId,
        search: opts.search,
        metadataSearch: opts.metadata,
        startDate,
        endDate,
        limit,
        includeRaw: opts.raw,
        baseUrl,
        apiKey,
      });

      // `--raw` is a REQUEST, not a grant. The route gates raw provider capture
      // behind org owner/admin and answers `rawCaptureVisible: false` when it
      // strips the columns. Without saying so, a viewer/member running `--raw`
      // sees rows with no provider payloads and reads that as "nothing was
      // captured" — the same silence-as-an-answer defect as the empty-envelope
      // fail-open above, one authorization layer up.
      if (opts.raw && rawCaptureVisible === false) {
        console.error(
          chalk.yellow(
            "  Raw provider capture was NOT returned: it is restricted to org owner/admin.\n" +
              "  The absence of provider_request/provider_response below is NOT evidence that none was captured.",
          ),
        );
      }

      // Client-side refine with the SAME core semantics the server applies —
      // deterministic date bounds + sample. Keeps CLI/server/dashboard aligned.
      const filter = buildLogFilter({
        search: opts.search,
        metadataSearch: opts.metadata,
        startDate,
        endDate,
        sample,
      });
      const filtered = filterLogs(records, filter);

      if (opts.json) {
        const payload = filtered.map((r) => {
          if (opts.raw) {
            return { ...r, ...redactLogRecordRaw(r) };
          }
          // SECURITY: strip raw provider payloads from non-raw JSON output.
          const { stdout, providerRequest, providerResponse, ...rest } = r;
          void stdout;
          void providerRequest;
          void providerResponse;
          return rest;
        });
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (filtered.length === 0) {
        console.log(chalk.dim("\n  No logs match this filter.\n"));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Logs (${filtered.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));
      for (const r of filtered) {
        const color = logStatusColor(r.status);
        console.log(
          `  ${color("●")} ${chalk.dim((r.id || "—").slice(0, 8).padEnd(8))} ` +
            `${color((r.status ?? "—").padEnd(9))} ${chalk.dim((r.model ?? "—").padEnd(18))} ` +
            `${chalk.dim(fmtLogDate(r.createdAt).padEnd(22))} ${snippet(r)}`,
        );

        if (opts.raw) {
          const capture = redactLogRecordRaw(r);
          if (capture.stdout !== undefined) {
            console.log(chalk.dim(`      stdout: ${capture.stdout.slice(0, 200)}`));
          }
          if (capture.providerRequest !== undefined) {
            console.log(
              chalk.dim(`      provider_request: ${JSON.stringify(capture.providerRequest).slice(0, 200)}`),
            );
          }
          if (capture.providerResponse !== undefined) {
            console.log(
              chalk.dim(`      provider_response: ${JSON.stringify(capture.providerResponse).slice(0, 200)}`),
            );
          }
        }
      }
      if (opts.raw) {
        console.log();
        console.log(
          chalk.yellow(
            "  Raw provider payloads are shown REDACTED (secrets + PII scrubbed). Handle with care.",
          ),
        );
      }
      console.log();
    });
}

export function registerLogs(program: Command): void {
  const logsCmd = program
    .command("logs")
    .description("View recent eval/scan run logs")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output (watch for new lines)", false)
    .option("-t, --type <type>", "Filter by type: eval or scan")
    .option("--list", "List available log files", false)
    .action(async (opts: { lines: string; follow: boolean; type?: string; list: boolean }) => {
      // Ensure log directory exists
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      }

      const logFiles = getLogFiles(opts.type);

      if (opts.list) {
        if (logFiles.length === 0) {
          console.log(chalk.dim("\n  No log files found.\n"));
          return;
        }
        console.log();
        console.log(chalk.bold("  Log Files"));
        console.log(chalk.dim("  " + "-".repeat(60)));
        for (const f of logFiles.sort().reverse()) {
          const stat = fs.statSync(path.join(LOG_DIR, f));
          const size = (stat.size / 1024).toFixed(1);
          const date = stat.mtime.toLocaleString();
          console.log(`  ${chalk.cyan(f.padEnd(40))} ${chalk.dim(`${size} KB`)}  ${chalk.dim(date)}`);
        }
        console.log();
        return;
      }

      // Find the most recent log file
      if (logFiles.length === 0) {
        // Check results.json as a fallback log source
        const resultsFile = path.join(os.homedir(), ".evalguard", "results.json");
        if (fs.existsSync(resultsFile)) {
          try {
            const runs = JSON.parse(fs.readFileSync(resultsFile, "utf-8")) as Array<Record<string, unknown>>;
            const filteredRuns = opts.type
              ? runs.filter((r) => r.type === opts.type)
              : runs;
            const recentRuns = filteredRuns.slice(-parseInt(opts.lines, 10));

            if (recentRuns.length === 0) {
              console.log(chalk.dim("\n  No log entries found.\n"));
              return;
            }

            console.log();
            console.log(chalk.bold("  Recent Run Log"));
            console.log(chalk.dim("  " + "-".repeat(70)));
            for (const run of recentRuns.reverse()) {
              const passRate = run.passRate as number;
              const color = passRate >= 0.8 ? chalk.green : passRate >= 0.5 ? chalk.yellow : chalk.red;
              const icon = passRate >= 0.8 ? chalk.green("PASS") : chalk.red("FAIL");
              console.log(
                `  ${chalk.dim(run.timestamp as string)} [${icon}] ${chalk.bold(String(run.name).slice(0, 30))} ` +
                `${color((passRate * 100).toFixed(0) + "%")} ${chalk.dim(`(${run.model})`)}`
              );
            }
            console.log();
          } catch {
            console.log(chalk.dim("\n  No log entries found.\n"));
          }
        } else {
          console.log(chalk.dim("\n  No log files found. Run an eval or scan first.\n"));
        }
        return;
      }

      const latestFile = logFiles.sort().reverse()[0];
      const logPath = path.join(LOG_DIR, latestFile);
      const numLines = parseInt(opts.lines, 10);

      console.log(chalk.dim(`  Reading ${latestFile}`));
      console.log(chalk.dim("  " + "-".repeat(60)));

      const lines = tailFile(logPath, numLines);
      for (const line of lines) {
        const formatted = formatLogLine(line);
        if (formatted) console.log(`  ${formatted}`);
      }

      if (opts.follow) {
        console.log(chalk.dim("\n  Watching for new log entries... (Ctrl+C to stop)\n"));
        let lastSize = fs.statSync(logPath).size;

        const watcher = setInterval(() => {
          try {
            const stat = fs.statSync(logPath);
            if (stat.size > lastSize) {
              const fd = fs.openSync(logPath, "r");
              const buf = Buffer.alloc(stat.size - lastSize);
              fs.readSync(fd, buf, 0, buf.length, lastSize);
              fs.closeSync(fd);
              const newLines = buf.toString("utf-8").split("\n");
              for (const line of newLines) {
                const formatted = formatLogLine(line);
                if (formatted) console.log(`  ${formatted}`);
              }
              lastSize = stat.size;
            }
          } catch {
            // File may have been rotated
          }
        }, 1000);

        process.on("SIGINT", () => {
          clearInterval(watcher);
          console.log(chalk.dim("\n  Stopped watching.\n"));
          process.exit(0);
        });

        // Keep the process alive
        await new Promise(() => {});
      }

      console.log();
    });

  // `evalguard logs list` — server-side log records.
  registerLogsList(logsCmd);
}
