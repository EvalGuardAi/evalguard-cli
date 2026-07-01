import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { fetchDecisionBomVerify, registerDecisionBom } from "../decision-bom.js";

const BOM = "00000000-0000-4000-8000-000000000001";

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

const VALID_BOM = {
  id: BOM,
  decisionId: "dec-1",
  surface: "firewall",
  verdict: "block",
  category: "prompt-injection",
  signedAt: "2026-05-30T00:00:00.000Z",
  createdAt: "2026-05-30T00:00:00.000Z",
  bom: { verdict: "block" },
  signature: { algorithm: "ed25519", value: "sig", publicKeyPem: "pem" },
  verification: { valid: true },
};

describe("fetchDecisionBomVerify", () => {
  it("rejects a non-UUID id before hitting the network", async () => {
    await expect(
      fetchDecisionBomVerify({ id: "nope", baseUrl: "https://x.test", apiKey: "k", fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/must be a valid UUID/);
  });

  it("GETs /compliance/decision-bom/<id> with a Bearer token and unwraps the envelope", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toContain(`/compliance/decision-bom/${BOM}`);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      return envelope(VALID_BOM);
    }) as unknown as typeof fetch;

    const out = await fetchDecisionBomVerify({ id: BOM, baseUrl: "https://x.test/api/v1", apiKey: "test-key", fetchImpl });
    expect(out.verification.valid).toBe(true);
    expect(out.verdict).toBe("block");
  });

  it("returns valid=false for a tampered BOM (does not throw)", async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({ ...VALID_BOM, verification: { valid: false, reason: "signature mismatch" } }),
    ) as unknown as typeof fetch;
    const out = await fetchDecisionBomVerify({ id: BOM, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl });
    expect(out.verification.valid).toBe(false);
    expect(out.verification.reason).toBe("signature mismatch");
  });

  it("surfaces a 404 NOT_FOUND error", async () => {
    const fetchImpl = vi.fn(async () => errorEnvelope("NOT_FOUND", "Decision BOM not found", 404)) as unknown as typeof fetch;
    await expect(
      fetchDecisionBomVerify({ id: BOM, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/HTTP 404.*NOT_FOUND/);
  });

  it("throws on a malformed response missing the verification block", async () => {
    const fetchImpl = vi.fn(async () => envelope({ id: BOM })) as unknown as typeof fetch;
    await expect(
      fetchDecisionBomVerify({ id: BOM, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/malformed server response/);
  });
});

describe("registerDecisionBom", () => {
  it("registers decision-bom with a verify subcommand", () => {
    const program = new Command();
    registerDecisionBom(program);
    const cmd = program.commands.find((c) => c.name() === "decision-bom");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toContain("verify");
  });
});
