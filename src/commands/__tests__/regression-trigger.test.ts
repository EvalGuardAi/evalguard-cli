import { describe, it, expect } from "vitest";
import {
  fireRegressionTrigger,
  getRegressionConfig,
  setRegressionConfig,
  listRegressionLog,
} from "../regression-trigger.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const opts = { baseUrl: "https://x.test/api/v1", apiKey: "eg_test" };

type Captured = { url?: string; init?: RequestInit };
function fakeFetch(cap: Captured, body: unknown, ok = true): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    cap.url = url;
    cap.init = init;
    return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe("regression-trigger CLI API fns", () => {
  it("fire POSTs the change event to /regression-tests/trigger", async () => {
    const cap: Captured = {};
    await fireRegressionTrigger({
      orgId: ORG, projectId: PROJ, changeType: "model_change", riskLevel: "high",
      ...opts, fetchImpl: fakeFetch(cap, { data: { enqueued: true } }),
    });
    expect(cap.url).toContain("/regression-tests/trigger");
    expect(cap.init?.method).toBe("POST");
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toMatchObject({ orgId: ORG, projectId: PROJ, changeType: "model_change", riskLevel: "high" });
    expect(cap.init?.headers).toMatchObject({ Authorization: "Bearer eg_test" });
  });

  it("fire validates UUIDs + requires changeType", async () => {
    await expect(
      fireRegressionTrigger({ orgId: "nope", projectId: PROJ, changeType: "x", ...opts }),
    ).rejects.toThrow(/orgId/);
    await expect(
      fireRegressionTrigger({ orgId: ORG, projectId: PROJ, changeType: "", ...opts }),
    ).rejects.toThrow(/changeType/);
  });

  it("config get hits the config endpoint with query params", async () => {
    const cap: Captured = {};
    await getRegressionConfig({ orgId: ORG, projectId: PROJ, ...opts, fetchImpl: fakeFetch(cap, { data: {} }) });
    expect(cap.url).toContain("/regression-tests/config?");
    expect(cap.url).toContain(`projectId=${PROJ}`);
    expect(cap.init?.method).toBe("GET");
  });

  it("config set PUTs only the provided fields", async () => {
    const cap: Captured = {};
    await setRegressionConfig({ orgId: ORG, projectId: PROJ, enabled: true, ...opts, fetchImpl: fakeFetch(cap, { data: {} }) });
    expect(cap.init?.method).toBe("PUT");
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toEqual({ orgId: ORG, projectId: PROJ, enabled: true });
  });

  it("config set passes a null triggerChangeTypes to clear the override", async () => {
    const cap: Captured = {};
    await setRegressionConfig({ orgId: ORG, projectId: PROJ, triggerChangeTypes: null, ...opts, fetchImpl: fakeFetch(cap, { data: {} }) });
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent.triggerChangeTypes).toBeNull();
  });

  it("log GETs with the limit param", async () => {
    const cap: Captured = {};
    await listRegressionLog({ orgId: ORG, projectId: PROJ, limit: 10, ...opts, fetchImpl: fakeFetch(cap, { data: [] }) });
    expect(cap.url).toContain("/regression-tests/log?");
    expect(cap.url).toContain("limit=10");
  });

  it("surfaces server-side error messages", async () => {
    const cap: Captured = {};
    await expect(
      fireRegressionTrigger({ orgId: ORG, projectId: PROJ, changeType: "deploy", ...opts, fetchImpl: fakeFetch(cap, { error: { message: "denied" } }, false) }),
    ).rejects.toThrow("denied");
  });
});
