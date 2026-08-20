import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  buildLogsQuery,
  toLogRecord,
  fetchLogs,
  fetchLogPage,
  buildLogFilter,
  parseDateFlag,
  parseSampleFlag,
  redactLogRecordRaw,
  registerLogs,
  type FetchLogsOptions,
  type LogRecord,
} from "../logs.js";

const BASE = "https://x.test/api/v1";
const KEY = "test-key";
const PROJECT = "00000000-0000-4000-8000-0000000000a2";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseOpts: Omit<FetchLogsOptions, "fetchImpl"> = {
  projectId: PROJECT,
  baseUrl: BASE,
  apiKey: KEY,
};

// ─── buildLogsQuery — Humanloop logs.list() param names ───────────────────────

describe("buildLogsQuery", () => {
  it("omits absent filters", () => {
    const qs = buildLogsQuery({ ...baseOpts });
    expect(qs).toBe(`projectId=${PROJECT}`);
  });

  /**
   * These four names are the ones this command got wrong. It sent the upstream
   * API's spelling (`metadata_search`, `start_date`, `end_date`,
   * `include_raw`); the handler reads camelCase plus `captureRaw`, and SILENTLY
   * IGNORES anything it does not recognise. So a wrong name would not have
   * errored — it would have dropped the filter and widened the answer.
   *
   * Asserted against apps/web/src/app/api/v1/monitoring/route.ts:
   *   params.get("search") / ("metadataSearch") / ("startDate") /
   *   ("endDate") / ("limit") / ("captureRaw") === "true"
   */
  it("uses the exact query parameters the monitoring route reads", () => {
    const qs = new URLSearchParams(
      buildLogsQuery({
        ...baseOpts,
        search: "hello world",
        metadataSearch: "tenant-a",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-02-01T00:00:00.000Z"),
        limit: 25,
        includeRaw: true,
      }),
    );
    expect(qs.get("search")).toBe("hello world");
    expect(qs.get("metadataSearch")).toBe("tenant-a");
    expect(qs.get("startDate")).toBe("2026-01-01T00:00:00.000Z");
    expect(qs.get("endDate")).toBe("2026-02-01T00:00:00.000Z");
    expect(qs.get("limit")).toBe("25");
    expect(qs.get("captureRaw")).toBe("true");
    // ...and NONE of the names the route ignores.
    for (const dead of ["metadata_search", "start_date", "end_date", "include_raw"]) {
      expect(qs.has(dead), `${dead} is ignored by the route — sending it drops the filter`).toBe(
        false,
      );
    }
  });

  it("does NOT send `sample` (the route samples too — that would sample a sample)", () => {
    const qs = new URLSearchParams(buildLogsQuery({ ...baseOpts, search: "x" }));
    expect(qs.has("sample")).toBe(false);
  });

  it("omits captureRaw when raw is not requested", () => {
    const qs = new URLSearchParams(buildLogsQuery({ ...baseOpts, includeRaw: false }));
    expect(qs.has("captureRaw")).toBe(false);
  });
});

// ─── toLogRecord — snake/camel tolerance + raw gating ─────────────────────────

describe("toLogRecord", () => {
  it("maps snake_case server rows into FilterableLog shape", () => {
    const rec = toLogRecord(
      {
        id: "log_1",
        inputs: { q: "hi" },
        output: "there",
        metadata: { user: "a" },
        created_at: "2026-01-15T00:00:00.000Z",
        model: "gpt-4o",
        status: "success",
      },
      false,
    );
    expect(rec.id).toBe("log_1");
    expect(rec.inputs).toEqual({ q: "hi" });
    expect(rec.output).toBe("there");
    expect(rec.metadata).toEqual({ user: "a" });
    expect(rec.createdAt).toBe("2026-01-15T00:00:00.000Z");
    expect(rec.model).toBe("gpt-4o");
    expect(rec.status).toBe("success");
  });

  it("drops raw provider fields unless includeRaw=true (security)", () => {
    const row = {
      id: "log_2",
      stdout: "debug line",
      provider_request: { headers: { authorization: "Bearer sk-secret" } },
      provider_response: { choices: [] },
    };
    const withoutRaw = toLogRecord(row, false);
    expect(withoutRaw.stdout).toBeUndefined();
    expect(withoutRaw.providerRequest).toBeUndefined();
    expect(withoutRaw.providerResponse).toBeUndefined();

    const withRaw = toLogRecord(row, true);
    expect(withRaw.stdout).toBe("debug line");
    expect(withRaw.providerRequest).toEqual({ headers: { authorization: "Bearer sk-secret" } });
    expect(withRaw.providerResponse).toEqual({ choices: [] });
  });

  it("accepts camelCase raw field names too", () => {
    const rec = toLogRecord(
      { id: "log_3", providerRequest: { a: 1 }, providerResponse: { b: 2 } },
      true,
    );
    expect(rec.providerRequest).toEqual({ a: 1 });
    expect(rec.providerResponse).toEqual({ b: 2 });
  });

  it("coerces missing/oddly-typed fields to null defaults", () => {
    const rec = toLogRecord({}, false);
    expect(rec.id).toBe("");
    expect(rec.inputs).toBeNull();
    expect(rec.output).toBeNull();
    expect(rec.metadata).toBeNull();
    expect(rec.createdAt).toBeNull();
    expect(rec.status).toBeNull();
  });

  // `production_logs` has no `status`; it has a guardrail `flagged` boolean.
  // Reported as itself, never dressed up as a run outcome.
  it("reports the guardrail `flagged` column instead of a status column of dashes", () => {
    expect(toLogRecord({ id: "a", flagged: true }, false).status).toBe("flagged");
    expect(toLogRecord({ id: "a", flagged: false }, false).status).toBe("ok");
    // An explicit `status` from any other producer still wins.
    expect(toLogRecord({ id: "a", flagged: true, status: "error" }, false).status).toBe("error");
  });
});

// ─── fetchLogs — envelope handling + injectable fetch ─────────────────────────

describe("fetchLogs", () => {
  /**
   * The URL is the whole defect. `GET /logs` had no handler in `apps/web` and
   * never had one, so this request resolved to `api/v1/[...catch]/route.ts`:
   * measured against a served build it returned HTTP 404 `{"error":"Not
   * found"}` — byte-identical to a nonsense path — while `/api/v1/monitoring`
   * in the same run answered 401 INVALID_API_KEY.
   */
  it("GETs /monitoring and unwraps `data.recentLogs`", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toBe(`${BASE}/monitoring?projectId=${PROJECT}&search=hi`);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      return json({
        success: true,
        data: { recentLogs: [{ id: "log_1", output: "hi there" }], total: 1 },
      });
    }) as unknown as typeof fetch;

    const rows = await fetchLogs({ ...baseOpts, search: "hi", fetchImpl });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("log_1");
  });

  it("REFUSES the envelopes invented for the endpoint that never existed", async () => {
    // A bare array and `{ logs: [...] }` were tolerated because nothing was
    // ever on the other end to contradict them. This handler has exactly one
    // success shape; accepting a body it cannot send is a second way to read
    // an unrecognised 200 as "no logs".
    for (const data of [[{ id: "a" }], { logs: [{ id: "a" }], total: 1 }]) {
      const fetchImpl = vi.fn(async () => json({ success: true, data })) as unknown as typeof fetch;
      await expect(
        fetchLogs({ ...baseOpts, fetchImpl }),
        `${JSON.stringify(data)} is not a shape GET /monitoring can send`,
      ).rejects.toThrow(/GET \/monitoring/);
    }
  });

  it("returns [] for a genuinely EMPTY result (control)", async () => {
    // Both real "no logs" answers: an empty page, and the fail-soft body the
    // route sends when `production_logs` cannot be queried at all.
    for (const data of [
      { recentLogs: [], total: 0 },
      { total: 0, flagged: 0, recentLogs: [], nextCursor: null, rawCaptureVisible: false },
    ]) {
      const fetchImpl = vi.fn(async () => json({ success: true, data })) as unknown as typeof fetch;
      expect(await fetchLogs({ ...baseOpts, fetchImpl })).toEqual([]);
    }
  });

  it("surfaces the route's rawCaptureVisible so a stripped --raw is not read as 'nothing captured'", async () => {
    const deny = vi.fn(async () =>
      json({ success: true, data: { recentLogs: [{ id: "a" }], rawCaptureVisible: false } }),
    ) as unknown as typeof fetch;
    expect((await fetchLogPage({ ...baseOpts, includeRaw: true, fetchImpl: deny })).rawCaptureVisible).toBe(
      false,
    );

    const allow = vi.fn(async () =>
      json({ success: true, data: { recentLogs: [{ id: "a" }], rawCaptureVisible: true } }),
    ) as unknown as typeof fetch;
    expect((await fetchLogPage({ ...baseOpts, fetchImpl: allow })).rawCaptureVisible).toBe(true);
  });

  it("REFUSES a body that is not this route's answer instead of reporting no logs", async () => {
    // This case used to be `it("returns [] when the payload has no rows")` with
    // `{ success: true, data: null }` — a test that PINNED the defect: it
    // asserted that "the server produced no result" and "your project logged
    // nothing" are the same answer. Measured on the built CLI,
    // `evalguard logs list --project <id>` printed
    //
    //     No logs match this filter.
    //
    // and exited 0 for `{"hello":"world"}`, `{"success":true,"data":null}`,
    // `{"success":true,"data":{}}` and an explicit `{"success":false,…}` at 200.
    // For an audit-log query that is the most misleading empty state in the CLI.
    for (const body of [
      { success: true, data: null },
      { success: true, data: {} },
      { hello: "world" },
    ]) {
      const fetchImpl = vi.fn(async () => json(body)) as unknown as typeof fetch;
      await expect(
        fetchLogs({ ...baseOpts, fetchImpl }),
        `${JSON.stringify(body)} must not read as "no logs"`,
      ).rejects.toThrow();
    }
  });

  it("propagates a structured HTTP error from the server envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ success: false, error: { code: "MISSING_PROJECT_ID", message: "projectId is required" } }, 400),
    ) as unknown as typeof fetch;
    await expect(fetchLogs({ ...baseOpts, fetchImpl })).rejects.toThrow(
      /HTTP 400.*MISSING_PROJECT_ID/,
    );
  });
});

// ─── buildLogFilter / parse flags ─────────────────────────────────────────────

describe("buildLogFilter", () => {
  it("carries sample into the core LogFilter (client-side sampling)", () => {
    const f = buildLogFilter({ search: "x", sample: 3 });
    expect(f).toEqual({ search: "x", sample: 3 });
  });

  it("omits absent fields", () => {
    expect(buildLogFilter({})).toEqual({});
  });
});

describe("parseDateFlag", () => {
  it("parses an ISO date", () => {
    expect(parseDateFlag("2026-01-01", "--since")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
  it("returns undefined for absent value", () => {
    expect(parseDateFlag(undefined, "--since")).toBeUndefined();
  });
  it("throws on garbage", () => {
    expect(() => parseDateFlag("not-a-date", "--until")).toThrow(/--until must be an ISO/);
  });
});

describe("parseSampleFlag", () => {
  it("parses a non-negative integer", () => {
    expect(parseSampleFlag("5")).toBe(5);
    expect(parseSampleFlag("0")).toBe(0);
  });
  it("returns undefined for absent value", () => {
    expect(parseSampleFlag(undefined)).toBeUndefined();
  });
  it("throws on negatives and non-integers", () => {
    expect(() => parseSampleFlag("-1")).toThrow(/non-negative integer/);
    expect(() => parseSampleFlag("1.5")).toThrow(/non-negative integer/);
    expect(() => parseSampleFlag("abc")).toThrow(/non-negative integer/);
  });
});

// ─── redactLogRecordRaw — defensive secret/PII scrub ──────────────────────────

describe("redactLogRecordRaw", () => {
  it("redacts credential-bearing keys in the raw provider payloads", () => {
    const rec: LogRecord = {
      id: "log_1",
      providerRequest: {
        headers: { authorization: "Bearer sk-verysecret", "x-api-key": "abc123" },
        model: "gpt-4o",
      },
      providerResponse: { id: "chatcmpl-1" },
      stdout: "ok",
    };
    const capture = redactLogRecordRaw(rec);
    const headers = (capture.providerRequest as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["x-api-key"]).toBe("[REDACTED]");
    // non-sensitive fields survive
    expect((capture.providerRequest as { model: string }).model).toBe("gpt-4o");
    expect(capture.providerResponse).toEqual({ id: "chatcmpl-1" });
    expect(capture.stdout).toBe("ok");
  });

  it("returns an empty capture when there are no raw fields", () => {
    expect(redactLogRecordRaw({ id: "x" })).toEqual({});
  });
});

// ─── end-to-end filter semantics (via core filterLogs) ────────────────────────

describe("logs list — filter integration", () => {
  it("client-side filter narrows fetched rows by search + date", async () => {
    const rows = [
      { id: "1", output: "hello world", created_at: "2026-01-10T00:00:00.000Z" },
      { id: "2", output: "unrelated", created_at: "2026-01-10T00:00:00.000Z" },
      { id: "3", output: "hello again", created_at: "2025-01-01T00:00:00.000Z" },
    ];
    const fetchImpl = vi.fn(async () =>
      json({ success: true, data: { recentLogs: rows } }),
    ) as unknown as typeof fetch;
    const records = await fetchLogs({ ...baseOpts, fetchImpl });

    const { filterLogs } = await import("@evalguard/core");
    const filtered = filterLogs(
      records,
      buildLogFilter({ search: "hello", startDate: new Date("2026-01-01T00:00:00.000Z") }),
    );
    // row 3 fails the date bound; row 2 fails search.
    expect(filtered.map((r) => r.id)).toEqual(["1"]);
  });

  /**
   * The repoint's sharpest edge. `production_logs` spells the prompt column
   * `input` (singular TEXT); the route builds an `inputs` alias ONLY to feed
   * core filterLogs and deletes it before responding. So the server can match a
   * row on its prompt text and the CLI's own re-filter would then drop it —
   * `--search` silently returning fewer rows than matched, with no error.
   *
   * The two states matter: without the `input` -> `inputs` mapping this test
   * yields [] where it should yield the row.
   */
  it("re-filters on the prompt text the SERVER matched on (input -> inputs)", async () => {
    const rows = [
      { id: "1", input: "summarise the contract", output: "", created_at: "2026-01-10T00:00:00.000Z" },
      { id: "2", input: "translate this", output: "", created_at: "2026-01-10T00:00:00.000Z" },
    ];
    const fetchImpl = vi.fn(async () =>
      json({ success: true, data: { recentLogs: rows } }),
    ) as unknown as typeof fetch;
    const records = await fetchLogs({ ...baseOpts, fetchImpl });
    expect(records[0].inputs).toEqual({ input: "summarise the contract" });

    const { filterLogs } = await import("@evalguard/core");
    expect(
      filterLogs(records, buildLogFilter({ search: "contract" })).map((r) => r.id),
      "a row the server matched on `input` must survive the client-side refine",
    ).toEqual(["1"]);
    // ...and the filter still discriminates.
    expect(filterLogs(records, buildLogFilter({ search: "translate" })).map((r) => r.id)).toEqual([
      "2",
    ]);
  });
});

// ─── command registration ─────────────────────────────────────────────────────

describe("registerLogs", () => {
  it("registers the `logs` command with a `list` subcommand", () => {
    const program = new Command();
    registerLogs(program);
    const logs = program.commands.find((c) => c.name() === "logs");
    expect(logs).toBeDefined();
    const subs = logs?.commands.map((c) => c.name()) ?? [];
    expect(subs).toContain("list");
  });

  it("`logs list` exposes the HL-parity flags + gated --raw", () => {
    const program = new Command();
    registerLogs(program);
    const list = program.commands
      .find((c) => c.name() === "logs")
      ?.commands.find((c) => c.name() === "list");
    const flags = (list?.options ?? []).map((o) => o.long);
    for (const f of ["--search", "--metadata", "--since", "--until", "--sample", "--raw", "--json"]) {
      expect(flags).toContain(f);
    }
  });
});
