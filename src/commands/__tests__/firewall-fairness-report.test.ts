import { describe, expect, it, vi } from "vitest";
import { fetchFirewallFairnessCli } from "../firewall-fairness-report.js";

const REPORT = {
  surface: "firewall",
  totalDecisions: 100,
  groupedDecisions: 100,
  ungroupedDecisions: 0,
  groups: ["EU", "US"],
  blockRatesByGroup: { EU: 0.8, US: 0.3 },
  disparateImpact: { ratio: 0.375, compliant: false },
  compliant: false,
  recommendations: ["Firewall block rate differs across groups…"],
  fairness: { overallScore: 47 },
  complianceRefs: { euAiAct: "EU AI Act Article 10", nistAiRmf: "NIST AI RMF MEASURE 2.11" },
};

describe("firewall-fairness-report CLI client", () => {
  it("POSTs /compliance/firewall-fairness with the audit body + bearer auth", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://x.test/api/v1/compliance/firewall-fairness");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer eg_k");
      expect(JSON.parse(String(init?.body))).toEqual({ orgId: "org-1", groupKey: "cohort" });
      return new Response(JSON.stringify({ success: true, data: REPORT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await fetchFirewallFairnessCli({
      body: { orgId: "org-1", groupKey: "cohort" },
      baseUrl: "https://x.test/api/v1",
      apiKey: "eg_k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.compliant).toBe(false);
    expect(result.disparateImpact.ratio).toBe(0.375);
    expect(result.blockRatesByGroup.EU).toBe(0.8);
  });

  it("throws with the status + body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      fetchFirewallFairnessCli({
        body: { orgId: "org-1" },
        baseUrl: "https://x.test/api/v1",
        apiKey: "eg_k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/firewall-fairness-report failed \(400\)/);
  });

  it("unwraps either { data } or a bare object", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(REPORT), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await fetchFirewallFairnessCli({
      body: { orgId: "org-1" },
      baseUrl: "https://x.test/api/v1",
      apiKey: "eg_k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.surface).toBe("firewall");
  });
});
