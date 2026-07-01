import { describe, expect, it, vi } from "vitest";
import { listEvaluators, diffEvaluators } from "../evaluators.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";

describe("evaluators CLI API client", () => {
  it("list: rejects a non-UUID project before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      listEvaluators({
        projectId: "not-a-uuid",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("list: GET /evaluators?projectId with Bearer token + optional name filter", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/evaluators?projectId=");
      expect(url).toContain(PROJECT);
      expect(url).toContain("name=faithfulness");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ name: "faithfulness", version: 2, kind: "llm-judge", is_active: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = (await listEvaluators({
      projectId: PROJECT,
      name: "faithfulness",
      baseUrl: "https://x.test/api/v1",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: unknown[] };
    expect(out.data).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("diff: POST /evaluators/diff with the version pair in the body", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/evaluators/diff");
      expect(init?.method).toBe("POST");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({
        projectId: PROJECT,
        name: "faithfulness",
        fromVersion: 1,
        toVersion: 2,
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: { diff: { changed: true, added: [], removed: [], modified: ["threshold"] } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = (await diffEvaluators({
      projectId: PROJECT,
      name: "faithfulness",
      fromVersion: 1,
      toVersion: 2,
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: { diff: { modified: string[] } } };
    expect(out.data.diff.modified).toContain("threshold");
  });

  it("surfaces the server error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Project not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      listEvaluators({
        projectId: PROJECT,
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Project not found/);
  });
});
