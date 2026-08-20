import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { fetchCostExport, COST_EXPORT_FORMATS, registerCostExport } from "../cost-export.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-0000000000a2";

/** One realistic NDJSON usage record, for the tests whose subject is not the body. */
const LAGO_EVENT = JSON.stringify({
  transaction_id: "evt_1",
  external_subscription_id: ORG,
  code: "llm_tokens",
  timestamp: 1754000000,
  properties: { model: "gpt-4o", total_tokens: 1200, cost_usd: 0.012 },
});

function mockResponse(
  body: string,
  opts: { status?: number; cd?: string; ct?: string; headers?: Record<string, string> } = {},
): Response {
  // A 204 carries a NULL body by spec; `new Response("", {status:204})` throws.
  return new Response(opts.status === 204 ? null : body, {
    status: opts.status ?? 200,
    headers: {
      ...(opts.cd ? { "content-disposition": opts.cd } : {}),
      "content-type": opts.ct ?? "text/csv; charset=utf-8",
      ...(opts.headers ?? {}),
    },
  });
}

describe("fetchCostExport", () => {
  it("rejects a non-UUID orgId before hitting the network", async () => {
    await expect(
      fetchCostExport({
        orgId: "nope",
        format: "focus",
        baseUrl: "https://x.test",
        apiKey: "k",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/orgId must be a valid UUID/);
  });

  it("rejects an unknown format", async () => {
    await expect(
      fetchCostExport({
        orgId: ORG,
        format: "csv" as unknown as "focus",
        baseUrl: "https://x.test",
        apiKey: "k",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/format must be one of/);
  });

  it("calls GET /cost/export with format + orgId + Bearer token", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toContain("/cost/export?");
      expect(url).toContain("format=focus");
      expect(url).toContain(`orgId=${ORG}`);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      return mockResponse("BilledCost,EffectiveCost\n0.01,0.01", {
        cd: 'attachment; filename="cost-from-server.csv"',
      });
    }) as unknown as typeof fetch;

    const out = await fetchCostExport({
      orgId: ORG,
      format: "focus",
      baseUrl: "https://x.test/api/v1",
      apiKey: "test-key",
      fetchImpl,
    });

    expect(out.body).toContain("BilledCost");
    expect(out.suggestedFilename).toBe("cost-from-server.csv");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("forwards optional projectId / start / end / currency as query params", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`projectId=${PROJECT}`);
      expect(url).toContain("startDate=2026-05-01");
      expect(url).toContain("endDate=2026-05-31");
      expect(url).toContain("currency=EUR");
      // A REAL Lago event line. This was `"{}"` — a placeholder chosen because
      // the assertions here are about the query string, not the body — and a
      // placeholder in a fixture is a claim about what the boundary accepts.
      // `{}` is an object, so the NDJSON arm passed it, and the CLI wrote two
      // bytes of nothing to disk as an org's billing record (measured on the
      // built 3.8.0 CLI, exit 0). The boundary now refuses a record with no
      // fields, so the fixture has to be one.
      return mockResponse(LAGO_EVENT, { ct: "application/x-ndjson" });
    }) as unknown as typeof fetch;

    await fetchCostExport({
      orgId: ORG,
      format: "lago",
      projectId: PROJECT,
      start: "2026-05-01",
      end: "2026-05-31",
      currency: "EUR",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to a sensible ndjson filename when server omits Content-Disposition", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(LAGO_EVENT, { ct: "application/x-ndjson" }),
    ) as unknown as typeof fetch;
    const out = await fetchCostExport({
      orgId: ORG,
      format: "openmeter",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.suggestedFilename).toMatch(/^evalguard-cost-openmeter-00000000\.ndjson$/);
  });

  it("REFUSES every measured fault body instead of exporting it", async () => {
    // Measured on the built 3.8.0 CLI, each of these was written to disk as a
    // FOCUS billing CSV — `✓ Wrote 0 bytes`, `✓ Wrote 157 bytes` (an nginx 502
    // page), `✓ Wrote 2097152 bytes` — and exited 0. With no `--out` the same
    // bytes went to stdout, which the README documents piping into a FinOps
    // ingest, so a 502 page becomes a billing record.
    const faults: Array<[string, string, number?]> = [
      ["invalid JSON", "this is not JSON at all {{{"],
      ["an empty body", ""],
      ["a 204", "", 204],
      ["a JSON null", "null"],
      ["a bare string", '"ok"'],
      ["an unrelated object", '{"hello":"world"}'],
      ["a success envelope with data:null", '{"success":true,"data":null}'],
      ["an empty success envelope", '{"success":true,"data":{}}'],
      ["a 200 carrying an error envelope", '{"success":false,"error":{"message":"boom"}}'],
      ["an nginx 502 page", "<html>\n<head><title>502 Bad Gateway</title></head>\n</html>"],
      ["2 MB of filler", "x".repeat(2 * 1024 * 1024)],
    ];
    for (const [what, body, status] of faults) {
      const fetchImpl = vi.fn(async () =>
        mockResponse(body, { status: status ?? 200 }),
      ) as unknown as typeof fetch;
      await expect(
        fetchCostExport({ orgId: ORG, format: "focus", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
        `${what} must never become a cost export`,
      ).rejects.toThrow(/was NOT written/);
    }
  });

  it("accepts a real FOCUS CSV and real NDJSON events (control)", async () => {
    // The refusals only mean something if the real export still works.
    const csv =
      "BillingPeriodStart,BillingPeriodEnd,ChargeDescription,BilledCost,BillingCurrency\r\n" +
      "2026-08-01,2026-08-31,openai/gpt-4o-mini,0.0142,USD\r\n";
    const csvFetch = vi.fn(async () => mockResponse(csv, { ct: "text/csv" })) as unknown as typeof fetch;
    const csvOut = await fetchCostExport({
      orgId: ORG, format: "focus", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: csvFetch,
    });
    expect(csvOut.body).toBe(csv);

    const nd = '{"specversion":"1.0","type":"llm.usage","id":"a"}\n{"specversion":"1.0","type":"llm.usage","id":"b"}';
    const ndFetch = vi.fn(async () => mockResponse(nd, { ct: "application/x-ndjson" })) as unknown as typeof fetch;
    const ndOut = await fetchCostExport({
      orgId: ORG, format: "openmeter", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: ndFetch,
    });
    expect(ndOut.body).toBe(nd);
  });

  it("accepts an EMPTY ndjson export only with the route's own header (control both ways)", async () => {
    // The route documents emitting an empty body for an NDJSON period with no
    // usage, while FOCUS still emits its header row. That legitimate empty must
    // pass, and an empty body WITHOUT the route's header — which is the
    // "✓ Wrote 0 bytes" fail-open — must not. Same input, both outcomes, so the
    // control cannot be satisfied by simply allowing every empty body.
    const withHeader = vi.fn(async () =>
      mockResponse("", { headers: { "x-evalguard-export-format": "lago" } }),
    ) as unknown as typeof fetch;
    const ok = await fetchCostExport({
      orgId: ORG, format: "lago", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: withHeader,
    });
    expect(ok.body).toBe("");

    const noHeader = vi.fn(async () => mockResponse("", {})) as unknown as typeof fetch;
    await expect(
      fetchCostExport({ orgId: ORG, format: "lago", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: noHeader }),
    ).rejects.toThrow(/EMPTY/);

    // …and FOCUS never gets the exemption, header or not.
    const focusEmpty = vi.fn(async () =>
      mockResponse("", { headers: { "x-evalguard-export-format": "focus" } }),
    ) as unknown as typeof fetch;
    await expect(
      fetchCostExport({ orgId: ORG, format: "focus", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: focusEmpty }),
    ).rejects.toThrow(/EMPTY/);
  });

  it("surfaces a structured error body on 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(JSON.stringify({ error: { code: "INVALID_FORMAT", message: "bad format" } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchCostExport({ orgId: ORG, format: "focus", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/HTTP 400.*INVALID_FORMAT.*bad format/);
  });
});

describe("registerCostExport", () => {
  it("registers the cost-export command with the three formats documented", () => {
    const program = new Command();
    registerCostExport(program);
    const cmd = program.commands.find((c) => c.name() === "cost-export");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("FinOps");
    for (const f of COST_EXPORT_FORMATS) {
      expect(["focus", "openmeter", "lago"]).toContain(f);
    }
  });
});
