import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { fetchCostExport, COST_EXPORT_FORMATS, registerCostExport } from "../cost-export.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-0000000000a2";

function mockResponse(body: string, opts: { status?: number; cd?: string; ct?: string } = {}): Response {
  return new Response(body, {
    status: opts.status ?? 200,
    headers: {
      ...(opts.cd ? { "content-disposition": opts.cd } : {}),
      "content-type": opts.ct ?? "text/csv; charset=utf-8",
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
      return mockResponse("{}", { ct: "application/x-ndjson" });
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
    const fetchImpl = vi.fn(async () => mockResponse("{}", { ct: "application/x-ndjson" })) as unknown as typeof fetch;
    const out = await fetchCostExport({
      orgId: ORG,
      format: "openmeter",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.suggestedFilename).toMatch(/^evalguard-cost-openmeter-00000000\.ndjson$/);
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
