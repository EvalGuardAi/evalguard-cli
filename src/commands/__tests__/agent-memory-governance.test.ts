import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../__tests__/helpers/response-double.js";
import { getMemoryGovernance, setMemoryGovernance, MEMORY_GOVERNANCE_MODES } from "../agent-memory.js";

const ORG = "00000000-0000-4000-8000-000000000010";
const PROJECT = "00000000-0000-4000-8000-000000000001";
const OPTS = { baseUrl: "https://x.test/api/v1", apiKey: "k" };

const SAMPLE_POLICY = {
  orgId: ORG,
  projectId: null,
  enabled: true,
  mode: "enforce" as const,
  config: { thresholds: { poisonMinConfidence: 0.3 }, requireApprovalOnRewrite: true, requireProvenance: true },
  updatedAt: "2026-07-17T00:00:00.000Z",
};

describe("agent-memory governance CLI API client", () => {
  it("exposes exactly the route's mode enum", () => {
    expect(MEMORY_GOVERNANCE_MODES).toEqual(["off", "monitor", "enforce"]);
  });

  it("get: rejects a non-UUID org before any network call", async () => {
    const f = vi.fn();
    await expect(
      getMemoryGovernance({ orgId: "nope", ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/UUID/);
    expect(f).not.toHaveBeenCalled();
  });

  it("get: GET /agent-memory/governance with orgId + projectId query params + Bearer token", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/agent-memory/governance?");
      expect(url).toContain(`orgId=${ORG}`);
      expect(url).toContain(`projectId=${PROJECT}`);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
      return jsonResponse({ success: true, data: { policy: SAMPLE_POLICY } });
    });
    const out = (await getMemoryGovernance({
      orgId: ORG,
      projectId: PROJECT,
      ...OPTS,
      fetchImpl: f as unknown as typeof fetch,
    })) as { data: { policy: typeof SAMPLE_POLICY } };
    expect(out.data.policy.mode).toBe("enforce");
    expect(f).toHaveBeenCalledOnce();
  });

  it("get: omits the query string entirely when org is unset (server resolves from key)", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toBe("https://x.test/api/v1/agent-memory/governance");
      return jsonResponse({ success: true, data: { policy: null } });
    });
    const out = (await getMemoryGovernance({ ...OPTS, fetchImpl: f as unknown as typeof fetch })) as {
      data: { policy: null };
    };
    expect(out.data.policy).toBeNull();
  });

  it("set: rejects a non-UUID org before any network call", async () => {
    const f = vi.fn();
    await expect(
      setMemoryGovernance({ orgId: "nope", mode: "enforce", ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/UUID/);
    expect(f).not.toHaveBeenCalled();
  });

  it("set: throws when no mutable knob is provided", async () => {
    const f = vi.fn();
    await expect(
      setMemoryGovernance({ orgId: ORG, ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/Nothing to set/);
    expect(f).not.toHaveBeenCalled();
  });

  it("set: PUT /agent-memory/governance nesting poisonMinConfidence under config.thresholds", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/agent-memory/governance");
      expect(init?.method).toBe("PUT");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({
        orgId: ORG,
        mode: "enforce",
        enabled: true,
        config: {
          thresholds: { poisonMinConfidence: 0.3 },
          requireApprovalOnRewrite: true,
          requireProvenance: true,
        },
      });
      // poisonMinConfidence must NOT sit at config's top level (route ConfigSchema is .strict()).
      expect(sent.config.poisonMinConfidence).toBeUndefined();
      return jsonResponse({ success: true, data: { policy: SAMPLE_POLICY } });
    });
    const out = (await setMemoryGovernance({
      orgId: ORG,
      mode: "enforce",
      enabled: true,
      config: { poisonMinConfidence: 0.3, requireApprovalOnRewrite: true, requireProvenance: true },
      ...OPTS,
      fetchImpl: f as unknown as typeof fetch,
    })) as { data: { policy: typeof SAMPLE_POLICY } };
    expect(out.data.policy.mode).toBe("enforce");
    expect(f).toHaveBeenCalledOnce();
  });

  it("set: omits config when no config knob is set (mode-only update)", async () => {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent).toEqual({ orgId: ORG, mode: "monitor" });
      expect(sent.config).toBeUndefined();
      return jsonResponse({ success: true, data: { policy: { ...SAMPLE_POLICY, mode: "monitor" } } });
    });
    await setMemoryGovernance({ orgId: ORG, mode: "monitor", ...OPTS, fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledOnce();
  });

  it("surfaces the server error message on a non-OK response", async () => {
    const f = vi.fn(
      async () =>
        jsonResponse({ error: { message: "Forbidden — admin role required" } }, 403),
    );
    await expect(
      setMemoryGovernance({ orgId: ORG, mode: "enforce", ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/admin role required/);
  });
});
