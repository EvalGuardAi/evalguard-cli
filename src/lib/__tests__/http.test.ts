/**
 * The fail-CLOSED decode and the bounded fetch, tested at the boundary itself.
 *
 * Each malformed-body case below was MEASURED against the real CLI first
 * (`evalguard runs --project p1` vs a stub backend); this file pins the
 * behaviour so the exit-0 fail-open cannot come back. See lib/http.ts.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  IndeterminateResponseError,
  INDETERMINATE_RESPONSE_CODE,
  decodeJsonBody,
  expectArray,
  expectBooleanField,
  expectNumberField,
  expectObject,
  expectResult,
  readArtifactBody,
  AI_BOM_MARKERS,
  resolveHttpTimeoutMs,
  timedFetch,
  unwrapApiEnvelope,
} from "../http.js";

/** Build a Response the way a server would, including the empty-body cases. */
function res(body: string | null, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

describe("decodeJsonBody — the 2xx success path fails CLOSED", () => {
  const cases: Array<[string, Response]> = [
    ["invalid JSON", res("this is not JSON at all {{{")],
    ["an HTML proxy error page", res("<html><body>502</body></html>")],
    ["an empty body", res("")],
    ["a whitespace-only body", res("   \n  ")],
    ["a 204", res(null, { status: 204 })],
    ["JSON null", res("null")],
    ["a bare string", res('"ok"')],
    ["a bare number", res("42")],
    ["a bare boolean", res("true")],
  ];

  for (const [label, response] of cases) {
    it(`rejects ${label}`, async () => {
      await expect(decodeJsonBody(response, "GET /evals")).rejects.toBeInstanceOf(
        IndeterminateResponseError,
      );
    });
  }

  it("carries a stable machine code and names the endpoint", async () => {
    const err = await decodeJsonBody(res("nope"), "GET /evals").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateResponseError);
    expect((err as IndeterminateResponseError).code).toBe(INDETERMINATE_RESPONSE_CODE);
    expect((err as Error).message).toContain("GET /evals");
  });

  it("never echoes more than a short prefix of an unreadable body", async () => {
    // An error body can carry the caller's own prompt text, and this string
    // lands in CI logs.
    const secret = "x".repeat(500) + "SENSITIVE_TAIL";
    const err = await decodeJsonBody(res(secret), "GET /evals").catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("SENSITIVE_TAIL");
  });

  // ── CONTROLS: these must pass both before and after the fix ──
  it("accepts a normal object body", async () => {
    await expect(decodeJsonBody(res('{"a":1}'), "GET /evals")).resolves.toEqual({ a: 1 });
  });

  it("accepts an EMPTY ARRAY — a fresh project legitimately has no runs", async () => {
    await expect(decodeJsonBody(res("[]"), "GET /evals")).resolves.toEqual([]);
  });
});

describe("decodeJsonBody — the error path stays best-effort", () => {
  it("returns the parsed error body so the caller can quote the server", async () => {
    const r = res('{"error":{"message":"Invalid API key"}}', { status: 401 });
    await expect(decodeJsonBody(r, "GET /evals")).resolves.toEqual({
      error: { message: "Invalid API key" },
    });
  });

  it("returns null for an unparseable error body rather than throwing over it", async () => {
    // The caller's own `if (!res.ok) throw` is what fails closed here, and it
    // must still produce its `HTTP 500` message.
    await expect(decodeJsonBody(res("<html>500</html>", { status: 500 }), "GET /x")).resolves.toBeNull();
  });
});

describe("unwrapApiEnvelope", () => {
  it("unwraps a healthy success envelope", () => {
    expect(unwrapApiEnvelope({ success: true, data: [1] }, "GET /evals")).toEqual([1]);
  });

  it("rejects data:null — this is what printed 'No eval runs found' and exited 0", () => {
    expect(() => unwrapApiEnvelope({ success: true, data: null }, "GET /evals")).toThrow(
      IndeterminateResponseError,
    );
  });

  it("rejects a success envelope with no data field at all", () => {
    expect(() => unwrapApiEnvelope({ success: true }, "GET /evals")).toThrow(
      IndeterminateResponseError,
    );
  });

  it("raises a 2xx apiError envelope instead of returning it", () => {
    expect(() =>
      unwrapApiEnvelope({ success: false, error: { message: "upstream boom" } }, "GET /evals"),
    ).toThrow(/upstream boom/);
  });

  it("passes a raw un-enveloped payload through", () => {
    expect(unwrapApiEnvelope({ id: "x" }, "GET /evals")).toEqual({ id: "x" });
    expect(unwrapApiEnvelope([1, 2], "GET /evals")).toEqual([1, 2]);
  });

  it("does not accept a verdict synthesised from the prototype chain", () => {
    // `"data" in obj` walks the prototype chain, so a single pollution primitive
    // would let an EMPTY body present a complete envelope. Own-property reads only.
    const polluted = Object.create({ success: true, data: [] }) as Record<string, unknown>;
    // No OWN `success` key ⇒ treated as a raw payload, never unwrapped to [].
    expect(unwrapApiEnvelope(polluted, "GET /evals")).toBe(polluted);
  });
});

describe("expectArray / expectObject", () => {
  it("expectArray accepts a list, including an empty one", () => {
    expect(expectArray([], "GET /evals")).toEqual([]);
    expect(expectArray([1], "GET /evals")).toEqual([1]);
  });

  it("expectArray rejects a non-list instead of defaulting to []", () => {
    // The old code was `unwrap<T[]>(body) ?? []`, which reported "no runs".
    expect(() => expectArray({ hello: "world" }, "GET /evals")).toThrow(IndeterminateResponseError);
    expect(() => expectArray(null, "GET /evals")).toThrow(IndeterminateResponseError);
  });

  it("expectArray's message names the shape but not the values", () => {
    const err = (() => {
      try {
        expectArray({ secretField: "hunter2" }, "GET /evals");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err.message).toContain("secretField");
    expect(err.message).not.toContain("hunter2");
  });

  it("expectObject rejects arrays and primitives", () => {
    expect(expectObject({ a: 1 }, "GET /x")).toEqual({ a: 1 });
    expect(() => expectObject([], "GET /x")).toThrow(IndeterminateResponseError);
    expect(() => expectObject("s", "GET /x")).toThrow(IndeterminateResponseError);
  });
});

describe("resolveHttpTimeoutMs", () => {
  it("defaults to 60s", () => {
    expect(resolveHttpTimeoutMs({})).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(60_000);
  });

  it("honours an explicit override", () => {
    expect(resolveHttpTimeoutMs({ EVALGUARD_HTTP_TIMEOUT_MS: "2500" })).toBe(2500);
  });

  it("supports an explicit opt-out", () => {
    for (const v of ["0", "off", "none", "OFF"]) {
      expect(resolveHttpTimeoutMs({ EVALGUARD_HTTP_TIMEOUT_MS: v })).toBe(0);
    }
  });

  it("falls back to the DEFAULT on garbage, never to unbounded", () => {
    // A typo in a CI env var must not silently remove the deadline.
    for (const v of ["abc", "-5", "", "   ", "NaN"]) {
      expect(resolveHttpTimeoutMs({ EVALGUARD_HTTP_TIMEOUT_MS: v })).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    }
  });
});

describe("timedFetch", () => {
  it("attaches a deadline when the caller supplies none", async () => {
    let seen: AbortSignal | undefined;
    await timedFetch(
      "http://example.invalid/x",
      {},
      {
        timeoutMs: 5000,
        fetchImpl: (async (_u: unknown, init?: RequestInit) => {
          seen = init?.signal ?? undefined;
          return new Response("{}");
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("aborts a hung request within the deadline", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
        );
      })) as unknown as typeof fetch;

    const started = Date.now();
    await expect(
      timedFetch("http://example.invalid/x", {}, { timeoutMs: 120, fetchImpl: hang }),
    ).rejects.toThrow(/timed out after 120ms/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("composes with a caller's own signal so the SHORTER deadline wins", async () => {
    // debug.ts / cloud-client.ts pass an explicit 10s; the 60s ceiling must not
    // lengthen it.
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted-by-caller")));
      })) as unknown as typeof fetch;

    await expect(
      timedFetch(
        "http://example.invalid/x",
        { signal: AbortSignal.timeout(60) },
        { timeoutMs: 30_000, fetchImpl: hang },
      ),
    ).rejects.toThrow(/aborted-by-caller/);
  });

  it("skips the deadline entirely when the ceiling is disabled", async () => {
    let seen: AbortSignal | null | undefined = null;
    await timedFetch(
      "http://example.invalid/x",
      {},
      {
        timeoutMs: 0,
        fetchImpl: (async (_u: unknown, init?: RequestInit) => {
          seen = init?.signal;
          return new Response("{}");
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).toBeUndefined();
  });
});

// ─── 2026-08-09: the helpers added after the 47 x 15 matrix ─────────────────

describe("expectResult — the replacement for ", () => {
  const EP = "POST /moderation/image";

  it("unwraps a success envelope and returns the data", () => {
    expect(expectResult({ success: true, data: { flagged: false, score: 0.1 } }, EP)).toEqual({
      flagged: false,
      score: 0.1,
    });
  });

  it("accepts a bare, un-enveloped payload (forward/backward compatibility)", () => {
    expect(expectResult({ flagged: true, score: 0.9 }, EP)).toEqual({ flagged: true, score: 0.9 });
  });

  it.each([
    ["a 200 carrying success:false", { success: false, error: { message: "vision provider timed out" } }],
    ["a success envelope with data:null", { success: true, data: null }],
    ["a JSON null", null],
    ["an array where an object was expected", [1, 2, 3]],
  ])("refuses %s", (_what, body) => {
    expect(() => expectResult(body, EP)).toThrow(IndeterminateResponseError);
  });

  it("refuses a body missing the fields the renderer is about to read", () => {
    //  and  are the two shapes
    // that produced  and  out of nothing.
    expect(() => expectResult({ hello: "world" }, EP, ["flagged", "score"])).toThrow(
      /missing .*flagged.*score/,
    );
    expect(() => expectResult({ success: true, data: {} }, EP, ["flagged"])).toThrow(/missing/);
  });

  it("names EVERY missing field at once, not just the first", () => {
    // A caller fixing its contract should need one round-trip, not five.
    expect(() => expectResult({ a: 1 }, EP, ["x", "y", "z"])).toThrow(/`x`, `y`, `z`/);
  });
});

describe("expectNumberField / expectBooleanField — no verdict from an absent value", () => {
  const EP = "POST /moderation/image";

  it("returns a finite number / a boolean when present", () => {
    expect(expectNumberField({ score: 0 }, "score", EP)).toBe(0);
    expect(expectBooleanField({ flagged: false }, "flagged", EP)).toBe(false);
  });

  it.each([
    ["absent", {}],
    ["null", { score: null }],
    ["a string", { score: "0.4" }],
    ["NaN", { score: Number.NaN }],
    ["Infinity", { score: Number.POSITIVE_INFINITY }],
  ])("refuses a score that is %s — the source of ", (_what, body) => {
    expect(() => expectNumberField(body, "score", EP)).toThrow(IndeterminateResponseError);
  });

  it("refuses a non-boolean verdict rather than spending falsy as 'clean'", () => {
    expect(() => expectBooleanField({}, "flagged", EP)).toThrow(IndeterminateResponseError);
    expect(() => expectBooleanField({ flagged: "no" }, "flagged", EP)).toThrow(/boolean verdict/);
  });
});

describe("readArtifactBody — a document, not an envelope", () => {
  const ai = (body: string, status = 200, contract = AI_BOM_MARKERS.cyclonedx) =>
    readArtifactBody(new Response(status === 204 ? null : body, { status }), {
      endpoint: "GET /ai-sbom?format=cyclonedx",
      format: "ai-bom",
      contract,
      what: "AI-BOM",
    });

  it("accepts the document the route emits (control)", async () => {
    const doc = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.0.0", components: {} });
    await expect(ai(doc)).resolves.toBe(doc);
  });

  it.each([
    ["invalid JSON", "this is not JSON at all {{{"],
    ["an empty body", ""],
    ["a JSON null", "null"],
    ["a bare string", '"ok"'],
    ["an unrelated object", '{"hello":"world"}'],
    ["an nginx 502 page", "<html><head><title>502</title></head></html>"],
    ["a success envelope", '{"success":true,"data":{}}'],
    ["a 200 error envelope", '{"success":false,"error":{"message":"boom"}}'],
    ["a document with no specVersion", '{"bomFormat":"CycloneDX","components":{}}'],
    ["a document with no components", '{"bomFormat":"CycloneDX","specVersion":"1.0.0"}'],
  ])("refuses %s", async (_what, body) => {
    await expect(ai(body)).rejects.toThrow(/was NOT written/);
  });

  it("refuses a 204 even though its body is legitimately absent", async () => {
    await expect(ai("", 204)).rejects.toThrow(/EMPTY/);
  });

  it("refuses a document whose marker is a DIFFERENT format", async () => {
    const doc = JSON.stringify({ bomFormat: "SPDX-2.3", specVersion: "1.0.0", components: {} });
    await expect(ai(doc)).rejects.toThrow(/"SPDX-2.3" but "CycloneDX" was requested/);
  });

  it("validates CSV as columnar and NDJSON as one object per line", async () => {
    const csv = (b: string) =>
      readArtifactBody(new Response(b), { endpoint: "GET /cost/export", format: "csv", what: "cost export" });
    const CSV = ["a,b", "1,2"].join("\n");
    await expect(csv(CSV)).resolves.toBe(CSV);
    await expect(csv('{"hello":"world"}')).rejects.toThrow(/JSON, not the CSV/);
    await expect(csv("x".repeat(1000))).rejects.toThrow(/comma-separated header/);

    const nd = (b: string) =>
      readArtifactBody(new Response(b), { endpoint: "GET /cost/export", format: "ndjson", what: "cost export" });
    const NDJSON = ['{"a":1}', '{"b":2}'].join("\n");
    await expect(nd(NDJSON)).resolves.toBe(NDJSON);
    await expect(nd(['{"a":1}', "not json"].join("\n"))).rejects.toThrow(/line 2 is not valid JSON/);
    await expect(nd("[1,2]")).rejects.toThrow(/where an NDJSON record was expected/);
  });

  // The NDJSON arm accepted ANY object per line, and `{}` is an object. The CSV
  // arm catches an unrelated 200 (`{"hello":"world"}` is not columnar) and the
  // AI-BOM arm refuses an empty document explicitly — NDJSON had neither guard,
  // so it was the one artifact format still fail-open. Measured on the built
  // 3.8.0 CLI against a stub answering 200 + `{}`:
  //
  //     $ evalguard cost-export <org> --format openmeter --out cost.ndjson
  //       ✓ Wrote 2 bytes to cost.ndjson
  //       OpenMeter CloudEvents NDJSON — POST these to /api/v1/events
  //     $ echo $?
  //     0
  //
  // Two bytes of `{}` filed as an org's billing record, with instructions to
  // POST it into a metering system. A record with no fields carries no cost,
  // no event and no case — it is the NDJSON spelling of the empty AI-BOM
  // document `checkAiBom` already refuses.
  it("refuses an NDJSON record that carries no fields", async () => {
    const nd = (b: string) =>
      readArtifactBody(new Response(b), { endpoint: "GET /cost/export", format: "ndjson", what: "cost export" });
    await expect(nd("{}")).rejects.toThrow(/line 1 carries no fields/);
    await expect(nd(['{"a":1}', "{}"].join("\n"))).rejects.toThrow(/line 2 carries no fields/);
    // Control: a real record with fields is still written, unchanged.
    await expect(nd('{"a":1}')).resolves.toBe('{"a":1}');
  });

  it("allowEmpty passes a zero-byte 200 and still refuses a 204", async () => {
    const nd = (b: string, status = 200) =>
      readArtifactBody(new Response(status === 204 ? null : b, { status }), {
        endpoint: "GET /cost/export",
        format: "ndjson",
        what: "cost export",
        allowEmpty: true,
      });
    await expect(nd("")).resolves.toBe("");
    await expect(nd("", 204)).rejects.toThrow(/EMPTY/);
  });
});
