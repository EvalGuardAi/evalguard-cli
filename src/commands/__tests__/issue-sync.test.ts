import { describe, expect, it, vi } from "vitest";
import { syncIssues, type IssueSyncFindingInput } from "../issue-sync.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";

const FINDINGS: IssueSyncFindingInput[] = [
  { cveId: "CVE-2024-1", file: "lodash@4.17.20", title: "Proto pollution", severity: "high" },
];

describe("issue-sync CLI API client", () => {
  it("rejects a non-UUID project before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      syncIssues({
        projectId: "not-a-uuid",
        provider: "github",
        findings: FINDINGS,
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid provider before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      syncIssues({
        projectId: PROJECT,
        provider: "gitlab" as unknown as "github",
        findings: FINDINGS,
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/github.*jira/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty findings array before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      syncIssues({
        projectId: PROJECT,
        provider: "github",
        findings: [],
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/non-empty/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs /integrations/issue-sync with a Bearer token and unwraps the envelope", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://x.test/api/v1/integrations/issue-sync");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      const body = JSON.parse(String(init?.body)) as { projectId: string; provider: string; findings: unknown[] };
      expect(body.projectId).toBe(PROJECT);
      expect(body.provider).toBe("github");
      expect(body.findings).toHaveLength(1);
      return new Response(
        JSON.stringify({
          success: true,
          data: { provider: "github", createdCount: 1, updatedCount: 0, closedCount: 0, errorCount: 0, created: [], updated: [], closed: [], errors: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await syncIssues({
      projectId: PROJECT,
      provider: "github",
      findings: FINDINGS,
      baseUrl: "https://x.test/api/v1",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.provider).toBe("github");
    expect(out.createdCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server error envelope message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: { code: "INTEGRATION_NOT_CONFIGURED", message: "No github integration configured" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      syncIssues({
        projectId: PROJECT,
        provider: "github",
        findings: FINDINGS,
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/No github integration configured/);
  });
});
