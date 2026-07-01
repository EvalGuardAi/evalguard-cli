import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  fetchGatewayConfig,
  setGatewayConfig,
  ROUTING_STRATEGIES,
  registerGatewayConfig,
} from "../gateway-config.js";

const ORG = "00000000-0000-4000-8000-000000000001";

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

describe("fetchGatewayConfig", () => {
  it("GETs /gateway with a Bearer token and unwraps the config", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toContain("/gateway");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      return envelope({ routing: { strategy: "thompson", availableStrategies: ["priority", "thompson"] }, cache: { enabled: true, ttlSec: 300 } });
    }) as unknown as typeof fetch;
    const out = await fetchGatewayConfig({ baseUrl: "https://x.test/api/v1", apiKey: "test-key", fetchImpl });
    expect(out.routing?.strategy).toBe("thompson");
  });

  it("surfaces a server error", async () => {
    const fetchImpl = vi.fn(async () => errorEnvelope("INTERNAL", "boom", 500)) as unknown as typeof fetch;
    await expect(fetchGatewayConfig({ baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl })).rejects.toThrow(/HTTP 500.*INTERNAL/);
  });
});

describe("setGatewayConfig", () => {
  it("rejects a non-UUID orgId", async () => {
    await expect(
      setGatewayConfig({
        update: { orgId: "nope", routingStrategy: "thompson" },
        baseUrl: "https://x.test",
        apiKey: "k",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/orgId must be a valid UUID/);
  });

  it("rejects an unknown strategy", async () => {
    await expect(
      setGatewayConfig({
        update: { orgId: ORG, routingStrategy: "magic" as unknown as "thompson" },
        baseUrl: "https://x.test",
        apiKey: "k",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/strategy must be one of/);
  });

  it("rejects a no-op set with no knobs", async () => {
    await expect(
      setGatewayConfig({ update: { orgId: ORG }, baseUrl: "https://x.test", apiKey: "k", fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/Nothing to set/);
  });

  it("PUTs the per-org routing config and unwraps the result", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toContain("/gateway");
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(String(init?.body));
      expect(body.orgId).toBe(ORG);
      expect(body.routingStrategy).toBe("least-cost");
      expect(body.cacheEnabled).toBe(false);
      return envelope({
        orgId: ORG,
        routingStrategy: "least-cost",
        enabled: true,
        cacheEnabled: false,
        cacheTtlSec: 300,
        note: "Routing is enforced on the hosted proxy.",
      });
    }) as unknown as typeof fetch;

    const out = await setGatewayConfig({
      update: { orgId: ORG, routingStrategy: "least-cost", enabled: true, cacheEnabled: false },
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.routingStrategy).toBe("least-cost");
    expect(out.cacheEnabled).toBe(false);
  });

  it("surfaces a 403 admin-only error from the server", async () => {
    const fetchImpl = vi.fn(async () => errorEnvelope("FORBIDDEN", "admin role required", 403)) as unknown as typeof fetch;
    await expect(
      setGatewayConfig({ update: { orgId: ORG, routingStrategy: "thompson" }, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/HTTP 403.*FORBIDDEN/);
  });

  it("exposes the learned-routing strategies (thompson + quality-cost)", () => {
    expect(ROUTING_STRATEGIES).toContain("thompson");
    expect(ROUTING_STRATEGIES).toContain("quality-cost");
  });
});

describe("registerGatewayConfig", () => {
  it("registers gateway-config with get / set subcommands", () => {
    const program = new Command();
    registerGatewayConfig(program);
    const cmd = program.commands.find((c) => c.name() === "gateway-config");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toContain("get");
    expect(subs).toContain("set");
  });
});
