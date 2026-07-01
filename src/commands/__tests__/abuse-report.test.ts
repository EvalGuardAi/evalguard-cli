import { describe, expect, it, vi } from "vitest";
import { listAbuseReports, fileAbuseReport } from "../abuse-report.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";

describe("abuse-report CLI API client", () => {
  it("list: rejects a non-UUID project before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      listAbuseReports({
        projectId: "not-a-uuid",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("list: GET /abuse-reports?projectId with optional status filter", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/abuse-reports?projectId=");
      expect(url).toContain(PROJECT);
      expect(url).toContain("status=open");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({ success: true, data: { reports: [{ id: "r1", category: "spam", severity: "low", status: "open" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = (await listAbuseReports({
      projectId: PROJECT,
      status: "open",
      baseUrl: "https://x.test/api/v1",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: { reports: unknown[] } };
    expect(out.data.reports).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("report: POST /abuse-reports with category + optional fields in the body", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/abuse-reports");
      expect(init?.method).toBe("POST");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({
        projectId: PROJECT,
        category: "harassment",
        description: "abusive dms",
        subjectId: "user-9",
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            report: { id: "rep-1", category: "harassment" },
            triage: {
              severity: "high",
              category: "harassment",
              dedupKey: "abc123",
              autoEscalate: true,
              feedToDetector: true,
              reasons: ["repeat offender"],
            },
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const out = (await fileAbuseReport({
      projectId: PROJECT,
      category: "harassment",
      description: "abusive dms",
      subjectId: "user-9",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: { triage: { severity: string; autoEscalate: boolean } } };
    expect(out.data.triage.severity).toBe("high");
    expect(out.data.triage.autoEscalate).toBe(true);
  });

  it("report: rejects an unknown category before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fileAbuseReport({
        projectId: PROJECT,
        // deliberately invalid to exercise the guard
        category: "not-a-category" as unknown as "spam",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/category must be one of/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("report: omits undefined optional fields from the payload", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent).toEqual({ projectId: PROJECT, category: "spam" });
      expect("description" in sent).toBe(false);
      expect("evidence" in sent).toBe(false);
      return new Response(JSON.stringify({ success: true, data: { report: { id: "r" }, triage: { severity: "low", category: "spam", dedupKey: "k", autoEscalate: false, feedToDetector: false, reasons: [] } } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    await fileAbuseReport({
      projectId: PROJECT,
      category: "spam",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
      listAbuseReports({
        projectId: PROJECT,
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Project not found/);
  });
});
