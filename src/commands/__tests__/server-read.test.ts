import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  apiRequest,
  fetchEvalRuns,
  fetchEvalRun,
  fetchScans,
  fetchScan,
  fetchTraces,
  fetchTrace,
  fetchPrompts,
  fetchServerScorers,
  fetchWebhooks,
  createWebhook,
  testWebhook,
  registerServerRead,
} from "../server-read.js";

const BASE = "https://x.test/api/v1";
const KEY = "test-key";
const ORG = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-0000000000a2";
const TRACE = "11111111-2222-4333-8444-555555555555";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── apiRequest envelope + error handling ────────────────────────────────────

describe("apiRequest", () => {
  it("sends a Bearer token and returns the parsed envelope", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toBe(`${BASE}/evals?projectId=${PROJECT}`);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      return json({ success: true, data: [] });
    }) as unknown as typeof fetch;

    const body = await apiRequest({
      path: `/evals?projectId=${PROJECT}`,
      baseUrl: BASE,
      apiKey: KEY,
      fetchImpl,
    });
    expect(body).toEqual({ success: true, data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serializes a POST body and sets the method", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit | undefined) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ a: 1 });
      return json({ success: true, data: { ok: true } });
    }) as unknown as typeof fetch;

    await apiRequest({ path: "/x", method: "POST", body: { a: 1 }, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws a structured error on 4xx using the server error envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ success: false, error: { code: "MISSING_PROJECT_ID", message: "projectId is required" } }, 400),
    ) as unknown as typeof fetch;

    await expect(
      apiRequest({ path: "/evals", baseUrl: BASE, apiKey: KEY, fetchImpl }),
    ).rejects.toThrow(/HTTP 400.*MISSING_PROJECT_ID.*projectId is required/);
  });
});

// ─── eval runs ───────────────────────────────────────────────────────────────

describe("fetchEvalRuns / fetchEvalRun", () => {
  it("GETs /evals?projectId and unwraps the data array", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/evals?projectId=${PROJECT}`);
      return json({
        success: true,
        data: [{ id: "r1", name: "run-1", model: "gpt-4o", status: "passed", score: 9, created_at: "", completed_at: null, duration: 10 }],
      });
    }) as unknown as typeof fetch;

    const rows = await fetchEvalRuns({ projectId: PROJECT, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("r1");
  });

  it("returns [] when the server data is null", async () => {
    const fetchImpl = vi.fn(async () => json({ success: true, data: null })) as unknown as typeof fetch;
    const rows = await fetchEvalRuns({ projectId: PROJECT, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows).toEqual([]);
  });

  it("GETs /evals/:id for a single run", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/evals/r1`);
      return json({ success: true, data: { id: "r1", status: "passed" } });
    }) as unknown as typeof fetch;
    const run = await fetchEvalRun({ id: "r1", baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(run.status).toBe("passed");
  });
});

// ─── security scans ──────────────────────────────────────────────────────────

describe("fetchScans / fetchScan", () => {
  it("GETs /security?projectId and forwards limit", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`/security?`);
      expect(url).toContain(`projectId=${PROJECT}`);
      expect(url).toContain("limit=10");
      return json({ success: true, data: [{ id: "s1", model: "gpt-4o", prompt: "p", status: "passed", attack_types: ["jailbreak"], created_at: "", completed_at: null }] });
    }) as unknown as typeof fetch;
    const rows = await fetchScans({ projectId: PROJECT, limit: 10, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows[0].id).toBe("s1");
  });

  it("GETs /security/:id for one scan", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/security/s1`);
      return json({ success: true, data: { id: "s1", status: "failed" } });
    }) as unknown as typeof fetch;
    const scan = await fetchScan({ id: "s1", baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(scan.status).toBe("failed");
  });
});

// ─── traces ──────────────────────────────────────────────────────────────────

describe("fetchTraces / fetchTrace", () => {
  it("unwraps the nested { data: { traces } } envelope", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`/traces?`);
      expect(url).toContain(`projectId=${PROJECT}`);
      return json({
        success: true,
        data: {
          traces: [{ traceId: "t1", rootSpanName: "root", duration: 5, spanCount: 2, services: [], status: "ok", startTime: 0 }],
          total: 1,
          source: "db",
          nextCursor: null,
        },
      });
    }) as unknown as typeof fetch;
    const rows = await fetchTraces({ projectId: PROJECT, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows).toHaveLength(1);
    expect(rows[0].traceId).toBe("t1");
  });

  it("rejects a non-UUID traceId before any network call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchTrace({ traceId: "nope", projectId: PROJECT, baseUrl: BASE, apiKey: KEY, fetchImpl }),
    ).rejects.toThrow(/traceId must be a UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GETs /traces/:traceId?projectId for a valid UUID", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/traces/${TRACE}?projectId=${PROJECT}`);
      return json({ success: true, data: { traceId: TRACE, status: "ok", spanCount: 3, waterfall: [] } });
    }) as unknown as typeof fetch;
    const trace = await fetchTrace({ traceId: TRACE, projectId: PROJECT, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(trace.traceId).toBe(TRACE);
  });
});

// ─── prompts ─────────────────────────────────────────────────────────────────

describe("fetchPrompts", () => {
  it("GETs /prompts?projectId and unwraps the array", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`/prompts?`);
      expect(url).toContain(`projectId=${PROJECT}`);
      return json({ success: true, data: [{ id: "p1", name: "sys", version: 2, content: "hi", variables: ["x"], created_at: "" }] });
    }) as unknown as typeof fetch;
    const rows = await fetchPrompts({ projectId: PROJECT, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows[0].name).toBe("sys");
    expect(rows[0].version).toBe(2);
  });
});

// ─── scorers (server registry) ───────────────────────────────────────────────

describe("fetchServerScorers", () => {
  it("unwraps the nested { data: { scorers } } envelope", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/scorers`);
      return json({ success: true, data: { scorers: [{ id: "exact-match", name: "Exact Match", description: "d" }], total: 1 } });
    }) as unknown as typeof fetch;
    const rows = await fetchServerScorers({ baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("exact-match");
  });
});

// ─── webhooks ────────────────────────────────────────────────────────────────

describe("fetchWebhooks / createWebhook / testWebhook", () => {
  it("rejects a non-UUID orgId", async () => {
    await expect(
      fetchWebhooks({ orgId: "nope", baseUrl: BASE, apiKey: KEY, fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/orgId must be a UUID/);
  });

  it("GETs /webhooks?orgId and unwraps the array", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/webhooks?orgId=${ORG}`);
      return json({ success: true, data: [{ id: "w1", org_id: ORG, url: "https://h.test", events: ["eval.completed"], enabled: true, consecutive_failures: 0, created_at: "" }] });
    }) as unknown as typeof fetch;
    const rows = await fetchWebhooks({ orgId: ORG, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(rows[0].id).toBe("w1");
  });

  it("POSTs /webhooks and returns the one-time secret", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toBe(`${BASE}/webhooks`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        orgId: ORG,
        url: "https://hooks.test/x",
        events: ["eval.completed"],
      });
      return json({ success: true, data: { id: "w2", org_id: ORG, url: "https://hooks.test/x", events: ["eval.completed"], enabled: true, consecutive_failures: 0, created_at: "", secret: "shhh" } }, 201);
    }) as unknown as typeof fetch;
    const created = await createWebhook({
      orgId: ORG,
      url: "https://hooks.test/x",
      events: ["eval.completed"],
      baseUrl: BASE,
      apiKey: KEY,
      fetchImpl,
    });
    expect(created.id).toBe("w2");
    expect(created.secret).toBe("shhh");
  });

  it("rejects createWebhook with an invalid URL before the network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      createWebhook({ orgId: ORG, url: "not a url", events: ["eval.completed"], baseUrl: BASE, apiKey: KEY, fetchImpl }),
    ).rejects.toThrow(/url must be a valid URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects createWebhook with no events", async () => {
    await expect(
      createWebhook({ orgId: ORG, url: "https://h.test", events: [], baseUrl: BASE, apiKey: KEY, fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/At least one event/);
  });

  it("testWebhook reads deliveries and computes a success rate", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/webhooks/deliveries?webhookId=${TRACE}&limit=20`);
      return json({
        success: true,
        data: {
          deliveries: [
            { event: "eval.completed", success: true, status_code: 200, created_at: "2026-06-30T00:00:00Z" },
            { event: "scan.completed", success: false, status_code: 500, created_at: "2026-06-29T00:00:00Z" },
          ],
          total: 2,
        },
      });
    }) as unknown as typeof fetch;
    const health = await testWebhook({ webhookId: TRACE, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(health.total).toBe(2);
    expect(health.successRate).toBeCloseTo(0.5);
    expect(health.lastDeliveryAt).toBe("2026-06-30T00:00:00Z");
  });

  it("testWebhook returns null successRate when there are no deliveries", async () => {
    const fetchImpl = vi.fn(async () => json({ success: true, data: { deliveries: [], total: 0 } })) as unknown as typeof fetch;
    const health = await testWebhook({ webhookId: TRACE, baseUrl: BASE, apiKey: KEY, fetchImpl });
    expect(health.successRate).toBeNull();
    expect(health.recent).toEqual([]);
  });
});

// ─── command registration ────────────────────────────────────────────────────

describe("registerServerRead", () => {
  it("registers the server-read top-level commands", () => {
    const program = new Command();
    registerServerRead(program);
    const names = program.commands.map((c) => c.name());
    for (const expected of ["runs", "scans", "traces", "prompts", "scorers", "webhooks"]) {
      expect(names).toContain(expected);
    }
  });

  it("registers get subcommands on runs/scans/traces/prompts", () => {
    const program = new Command();
    registerServerRead(program);
    for (const parent of ["runs", "scans", "traces", "prompts"]) {
      const cmd = program.commands.find((c) => c.name() === parent);
      expect(cmd?.commands.map((c) => c.name())).toContain("get");
    }
  });

  it("registers list/create/test subcommands on webhooks", () => {
    const program = new Command();
    registerServerRead(program);
    const webhooks = program.commands.find((c) => c.name() === "webhooks");
    const subs = webhooks?.commands.map((c) => c.name()) ?? [];
    expect(subs).toContain("list");
    expect(subs).toContain("create");
    expect(subs).toContain("test");
  });
});
