import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  runRagAutoMLStudy,
  listRagAutoMLStudies,
  getRagAutoMLStudy,
  registerRagAutoML,
} from "../rag-automl.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const STUDY = "11111111-0000-4000-8000-000000000001";

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STUDY_RESULT = {
  id: STUDY,
  name: "search",
  status: "completed",
  objective: "ndcg",
  objectiveK: 10,
  ks: [1, 5, 10],
  totalConfigs: 4,
  evaluatedConfigs: 4,
  failedConfigs: 0,
  bestConfig: { chunkSize: 512 },
  bestObjectiveValue: 0.92,
  leaderboard: [{ rank: 1, configIndex: 0, config: { chunkSize: 512 }, objectiveValue: 0.92, metrics: {} }],
  message: "Ranked 4/4 configs by ndcg@10.",
};

describe("runRagAutoMLStudy", () => {
  it("rejects a config without a valid projectId", async () => {
    await expect(
      runRagAutoMLStudy({ config: { name: "x" }, baseUrl: "https://x.test", apiKey: "k", fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/projectId must be a valid project UUID/);
  });

  it("POSTs the config to /experiments/rag-automl and unwraps the leaderboard", async () => {
    const config = { projectId: PROJECT, name: "search", searchSpace: { chunkSize: [256, 512] }, qrels: {}, runs: {} };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toContain("/experiments/rag-automl");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      expect(JSON.parse(String(init?.body)).projectId).toBe(PROJECT);
      return envelope(STUDY_RESULT, 201);
    }) as unknown as typeof fetch;

    const out = await runRagAutoMLStudy({ config, baseUrl: "https://x.test/api/v1", apiKey: "test-key", fetchImpl });
    expect(out.id).toBe(STUDY);
    expect(out.leaderboard?.[0].objectiveValue).toBe(0.92);
  });

  it("surfaces a validation error from the server", async () => {
    const config = { projectId: PROJECT, name: "search", searchSpace: {}, qrels: {}, runs: {} };
    const fetchImpl = vi.fn(async () => errorEnvelope("VALIDATION_ERROR", "search space too large", 400)) as unknown as typeof fetch;
    await expect(
      runRagAutoMLStudy({ config, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/HTTP 400.*VALIDATION_ERROR/);
  });
});

describe("listRagAutoMLStudies", () => {
  it("rejects a non-UUID projectId", async () => {
    await expect(
      listRagAutoMLStudies({ projectId: "nope", baseUrl: "https://x.test", apiKey: "k", fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/must be a valid UUID/);
  });

  it("GETs the study list for a project", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`/experiments/rag-automl?projectId=${PROJECT}`);
      return envelope([{ id: STUDY, name: "search", objective: "ndcg", objective_k: 10, status: "completed" }]);
    }) as unknown as typeof fetch;
    const out = await listRagAutoMLStudies({ projectId: PROJECT, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
  });
});

describe("getRagAutoMLStudy", () => {
  it("GETs one study + leaderboard with studyId + projectId", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`studyId=${STUDY}`);
      expect(url).toContain(`projectId=${PROJECT}`);
      return envelope(STUDY_RESULT);
    }) as unknown as typeof fetch;
    const out = await getRagAutoMLStudy({ studyId: STUDY, projectId: PROJECT, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl });
    expect(out.id).toBe(STUDY);
    expect(out.leaderboard).toHaveLength(1);
  });
});

describe("registerRagAutoML", () => {
  it("registers rag-automl with run / list / get subcommands", () => {
    const program = new Command();
    registerRagAutoML(program);
    const cmd = program.commands.find((c) => c.name() === "rag-automl");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toContain("run");
    expect(subs).toContain("list");
    expect(subs).toContain("get");
  });
});
