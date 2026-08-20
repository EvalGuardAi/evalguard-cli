import { describe, it, expect } from "vitest";
import { jsonResponse } from "../../__tests__/helpers/response-double.js";
import {
  createShadowConfig,
  listShadowConfigs,
  evaluateShadow,
  deleteShadowConfig,
} from "../guardrail-shadow.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const CFG = "33333333-3333-4333-8333-333333333333";
const opts = { baseUrl: "https://x.test/api/v1", apiKey: "eg_test" };

type Captured = { url?: string; init?: RequestInit };
function fakeFetch(cap: Captured, body: unknown, ok = true): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    cap.url = url;
    cap.init = init;
    // A REAL Response, not `{ok,status,json} as Response`. That cast asserted a
    // shape the double did not have: the CLI's shared decode boundary
    // (lib/http.ts) reads `res.text()` so it can tell an EMPTY body and a
    // non-JSON body apart from a parsed one — a distinction `.json()` alone
    // cannot make, and the whole point of the fail-closed decode. A double that
    // implements only half of `Response` tests a code path the shipped CLI never
    // takes.
    return jsonResponse(body, ok ? 200 : 400);
  }) as unknown as typeof fetch;
}

describe("guardrail-shadow CLI API fns", () => {
  it("create POSTs the config (only provided fields) with auth header", async () => {
    const cap: Captured = {};
    await createShadowConfig({
      orgId: ORG, projectId: PROJ, name: "stricter-pii", shadowSensitivity: "strict", shadowRules: ["pii"],
      ...opts, fetchImpl: fakeFetch(cap, { data: { id: CFG, name: "stricter-pii" } }),
    });
    expect(cap.url).toContain("/gateway/guardrails/shadow");
    expect(cap.init?.method).toBe("POST");
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toEqual({ orgId: ORG, projectId: PROJ, name: "stricter-pii", shadowSensitivity: "strict", shadowRules: ["pii"] });
    expect(cap.init?.headers).toMatchObject({ Authorization: "Bearer eg_test" });
  });

  it("create validates UUIDs + requires name", async () => {
    await expect(createShadowConfig({ orgId: "nope", projectId: PROJ, name: "x", ...opts })).rejects.toThrow(/orgId/);
    await expect(createShadowConfig({ orgId: ORG, projectId: PROJ, name: "", ...opts })).rejects.toThrow(/name/);
  });

  it("list GETs with query params", async () => {
    const cap: Captured = {};
    await listShadowConfigs({ orgId: ORG, projectId: PROJ, ...opts, fetchImpl: fakeFetch(cap, { data: [] }) });
    expect(cap.url).toContain("/gateway/guardrails/shadow?");
    expect(cap.url).toContain(`projectId=${PROJ}`);
    expect(cap.init?.method).toBe("GET");
  });

  it("evaluate POSTs the content sample + field", async () => {
    const cap: Captured = {};
    await evaluateShadow({
      orgId: ORG, projectId: PROJ, configId: CFG, content: "my ssn is 123-45-6789", field: "input",
      ...opts, fetchImpl: fakeFetch(cap, { data: { divergence: "shadow-stricter" } }),
    });
    expect(cap.url).toContain("/gateway/guardrails/shadow/evaluate");
    expect(cap.init?.method).toBe("POST");
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toMatchObject({ orgId: ORG, projectId: PROJ, configId: CFG, content: "my ssn is 123-45-6789", field: "input" });
  });

  it("evaluate requires content + a UUID config", async () => {
    await expect(evaluateShadow({ orgId: ORG, projectId: PROJ, configId: "nope", content: "x", ...opts })).rejects.toThrow(/configId/);
    await expect(evaluateShadow({ orgId: ORG, projectId: PROJ, configId: CFG, content: "", ...opts })).rejects.toThrow(/content/);
  });

  it("rm DELETEs by id", async () => {
    const cap: Captured = {};
    await deleteShadowConfig({ orgId: ORG, configId: CFG, ...opts, fetchImpl: fakeFetch(cap, { data: { deleted: true } }) });
    expect(cap.init?.method).toBe("DELETE");
    expect(cap.url).toContain(`id=${CFG}`);
  });

  it("surfaces server-side error messages", async () => {
    const cap: Captured = {};
    await expect(
      listShadowConfigs({ orgId: ORG, projectId: PROJ, ...opts, fetchImpl: fakeFetch(cap, { error: { message: "nope" } }, false) }),
    ).rejects.toThrow("nope");
  });
});
