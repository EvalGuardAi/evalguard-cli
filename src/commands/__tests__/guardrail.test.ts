import { describe, it, expect } from "vitest";
import { jsonResponse } from "../../__tests__/helpers/response-double.js";
import {
  listGuardrailConfigs,
  setGuardrailConfig,
  deleteGuardrailConfig,
  findGuardrailIdByVendor,
  isLocalGuardrailVendor,
  LOCAL_GUARDRAIL_VENDORS,
  GUARDRAIL_ON_FLAG,
} from "../guardrail.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJ = "11111111-1111-4111-8111-111111111111";
const ROW = "33333333-3333-4333-8333-333333333333";
const SECRET = "44444444-4444-4444-8444-444444444444";
const opts = { baseUrl: "https://x.test/api/v1", apiKey: "eg_test" };

type Captured = { url?: string; init?: RequestInit };
function fakeFetch(cap: Captured, body: unknown, ok = true): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    cap.url = url;
    cap.init = init;
    // A REAL Response — see the note in guardrail-shadow.test.ts. The CLI's
    // shared decode boundary reads `res.text()`, so a double implementing only
    // `.json()` exercises a path the shipped CLI never takes.
    return jsonResponse(body, ok ? 200 : 400);
  }) as unknown as typeof fetch;
}

describe("guardrail CLI API fns", () => {
  it("exposes exactly the four local guardrail vendors (incl. both Wave-2 agent guardrails)", () => {
    expect([...LOCAL_GUARDRAIL_VENDORS]).toEqual([
      "local-firewall",
      "moderated-firewall",
      "data-not-instructions",
      "tool-call-circuit-breaker",
    ]);
    expect(isLocalGuardrailVendor("data-not-instructions")).toBe(true);
    expect(isLocalGuardrailVendor("tool-call-circuit-breaker")).toBe(true);
    expect(isLocalGuardrailVendor("aporia")).toBe(false);
    expect(GUARDRAIL_ON_FLAG).toEqual(["block", "redact", "flag"]);
  });

  it("list GETs with the projectId query param + Bearer header", async () => {
    const cap: Captured = {};
    await listGuardrailConfigs({ projectId: PROJ, ...opts, fetchImpl: fakeFetch(cap, { data: [] }) });
    expect(cap.url).toContain("/gateway/guardrails?");
    expect(cap.url).toContain(`projectId=${PROJ}`);
    expect(cap.init?.method).toBe("GET");
    expect(cap.init?.headers).toMatchObject({ Authorization: "Bearer eg_test" });
  });

  it("list rejects a non-UUID project before any network call", async () => {
    await expect(listGuardrailConfigs({ projectId: "nope", ...opts })).rejects.toThrow(/projectId/);
  });

  it("set POSTs a LOCAL Wave-2 guardrail WITHOUT a secretRef (only provided fields)", async () => {
    const cap: Captured = {};
    await setGuardrailConfig({
      orgId: ORG,
      projectId: PROJ,
      vendor: "data-not-instructions",
      onFlag: "block",
      checkRequest: true,
      ...opts,
      fetchImpl: fakeFetch(cap, { data: { id: ROW, vendor: "data-not-instructions" } }),
    });
    expect(cap.url).toContain("/gateway/guardrails");
    expect(cap.init?.method).toBe("POST");
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toEqual({
      orgId: ORG,
      projectId: PROJ,
      vendor: "data-not-instructions",
      onFlag: "block",
      checkRequest: true,
    });
    // CRITICAL: a local guardrail must never carry a secretRef.
    expect(sent.secretRef).toBeUndefined();
  });

  it("set sends the tool-call-circuit-breaker config (maxRepeats) with no secretRef", async () => {
    const cap: Captured = {};
    await setGuardrailConfig({
      orgId: ORG,
      projectId: PROJ,
      vendor: "tool-call-circuit-breaker",
      config: { maxRepeats: 3 },
      checkResponse: true,
      ...opts,
      fetchImpl: fakeFetch(cap, { data: { id: ROW } }),
    });
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toEqual({
      orgId: ORG,
      projectId: PROJ,
      vendor: "tool-call-circuit-breaker",
      config: { maxRepeats: 3 },
      checkResponse: true,
    });
    expect(sent.secretRef).toBeUndefined();
  });

  it("set POSTs a VENDOR guardrail WITH the secretRef it requires", async () => {
    const cap: Captured = {};
    await setGuardrailConfig({
      orgId: ORG,
      projectId: PROJ,
      vendor: "aporia",
      secretRef: SECRET,
      ...opts,
      fetchImpl: fakeFetch(cap, { data: { id: ROW, vendor: "aporia" } }),
    });
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toMatchObject({ orgId: ORG, projectId: PROJ, vendor: "aporia", secretRef: SECRET });
  });

  it("set rejects a secretRef on a LOCAL guardrail before any network call", async () => {
    await expect(
      setGuardrailConfig({ orgId: ORG, projectId: PROJ, vendor: "local-firewall", secretRef: SECRET, ...opts }),
    ).rejects.toThrow(/must not carry a secretRef/);
  });

  it("set requires a secretRef for a VENDOR guardrail", async () => {
    await expect(
      setGuardrailConfig({ orgId: ORG, projectId: PROJ, vendor: "lakera", ...opts }),
    ).rejects.toThrow(/requires a secretRef/);
  });

  it("set validates org/project/secretRef UUIDs + the onFlag enum", async () => {
    await expect(setGuardrailConfig({ orgId: "nope", projectId: PROJ, vendor: "local-firewall", ...opts })).rejects.toThrow(/orgId/);
    await expect(setGuardrailConfig({ orgId: ORG, projectId: "nope", vendor: "local-firewall", ...opts })).rejects.toThrow(/projectId/);
    await expect(
      setGuardrailConfig({ orgId: ORG, projectId: PROJ, vendor: "aporia", secretRef: "nope", ...opts }),
    ).rejects.toThrow(/secretRef must be a valid UUID/);
    await expect(
      setGuardrailConfig({ orgId: ORG, projectId: PROJ, vendor: "local-firewall", onFlag: "nuke" as never, ...opts }),
    ).rejects.toThrow(/onFlag/);
  });

  it("set omits unset optional fields (mode-minimal payload)", async () => {
    const cap: Captured = {};
    await setGuardrailConfig({
      orgId: ORG,
      projectId: PROJ,
      vendor: "moderated-firewall",
      ...opts,
      fetchImpl: fakeFetch(cap, { data: { id: ROW } }),
    });
    const sent = JSON.parse(String(cap.init?.body));
    expect(sent).toEqual({ orgId: ORG, projectId: PROJ, vendor: "moderated-firewall" });
  });

  it("delete DELETEs with projectId + id query params", async () => {
    const cap: Captured = {};
    await deleteGuardrailConfig({ projectId: PROJ, id: ROW, ...opts, fetchImpl: fakeFetch(cap, { data: { deleted: ROW } }) });
    expect(cap.init?.method).toBe("DELETE");
    expect(cap.url).toContain(`projectId=${PROJ}`);
    expect(cap.url).toContain(`id=${ROW}`);
  });

  it("delete validates both UUIDs", async () => {
    await expect(deleteGuardrailConfig({ projectId: PROJ, id: "nope", ...opts })).rejects.toThrow(/id/);
    await expect(deleteGuardrailConfig({ projectId: "nope", id: ROW, ...opts })).rejects.toThrow(/projectId/);
  });

  // The fixtures below send `{ success: true, data: … }`, the shape
  // `apiSuccess()` actually emits. They used to send a bare `{ data: … }`,
  // which no route produces: the module's old local unwrap keyed off the
  // presence of `data` alone, so the fixture drifted to match the helper
  // instead of the server. The shared `unwrapApiEnvelope` keys off `success`,
  // deliberately mirroring packages/mcp-server/response-contract.ts.
  it("findGuardrailIdByVendor resolves a row id from the vendor (unwraps the envelope)", async () => {
    const cap: Captured = {};
    const rows = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", vendor: "local-firewall" },
      { id: ROW, vendor: "data-not-instructions" },
    ];
    const id = await findGuardrailIdByVendor({
      projectId: PROJ,
      vendor: "data-not-instructions",
      ...opts,
      fetchImpl: fakeFetch(cap, { success: true, data: rows }),
    });
    expect(id).toBe(ROW);
    expect(cap.init?.method).toBe("GET");
  });

  it("findGuardrailIdByVendor returns null when no row matches the vendor", async () => {
    const cap: Captured = {};
    const id = await findGuardrailIdByVendor({
      projectId: PROJ,
      vendor: "aporia",
      ...opts,
      fetchImpl: fakeFetch(cap, { success: true, data: [{ id: ROW, vendor: "local-firewall" }] }),
    });
    expect(id).toBeNull();
  });

  it("surfaces server-side error messages", async () => {
    const cap: Captured = {};
    await expect(
      listGuardrailConfigs({ projectId: PROJ, ...opts, fetchImpl: fakeFetch(cap, { error: { message: "admin role required" } }, false) }),
    ).rejects.toThrow("admin role required");
  });
});

// A response that is not this endpoint's list must NOT read as "no config for
// that vendor" — that answer makes a caller create a duplicate guardrail, or
// report an existing guardrail as absent.
describe("findGuardrailIdByVendor fails closed", () => {
  it("refuses a 200 whose payload is not a list", async () => {
    const cap: Captured = {};
    await expect(
      findGuardrailIdByVendor({
        projectId: PROJ,
        vendor: "aporia",
        ...opts,
        fetchImpl: fakeFetch(cap, { success: true, data: { rows: "surprise" } }),
      }),
    ).rejects.toThrow(/where a list was expected/);
  });

  it("still returns null for a genuinely empty list (control)", async () => {
    const cap: Captured = {};
    await expect(
      findGuardrailIdByVendor({
        projectId: PROJ,
        vendor: "aporia",
        ...opts,
        fetchImpl: fakeFetch(cap, { success: true, data: [] }),
      }),
    ).resolves.toBeNull();
  });
});
