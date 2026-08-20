import { describe, it, expect } from "vitest";
import {
  complianceCheckUrl,
  complianceCheckPayload,
  normalizeRemoteResult,
  providerApiKeyEnvVar,
} from "../compliance-check.js";
import { DEFAULT_BASE_URL } from "../../lib/config.js";

describe("complianceCheckUrl (cli-compliance-double-apiv1-prefix)", () => {
  it("appends only the route path — no double /api/v1", () => {
    const url = complianceCheckUrl(DEFAULT_BASE_URL);
    expect(url).toBe("https://evalguard.ai/api/v1/compliance/check");
    // The regression: the old code produced /api/v1/api/v1/compliance/check.
    expect(url).not.toContain("/api/v1/api/v1");
    expect(url.match(/\/api\/v1/g)?.length).toBe(1);
  });

  it("works for a custom base URL that already carries /api/v1", () => {
    expect(complianceCheckUrl("https://eg.test/api/v1")).toBe(
      "https://eg.test/api/v1/compliance/check",
    );
  });
});

describe("complianceCheckPayload (cli-compliance-missing-orgId-400)", () => {
  const base = { framework: "owasp-llm" as const, model: "gpt-4o", threshold: 70 };
  const ORG = "11111111-2222-3333-4444-555555555555";
  const env = { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv;

  it("includes orgId in the body so the route's Zod schema accepts it", () => {
    const body = complianceCheckPayload({ ...base, orgId: ORG }, env);
    // The regression: the old body was { framework, model, systemPrompt } with
    // no orgId, which the route's `orgId: z.string().uuid()` rejected (400).
    expect(body.orgId).toBe(ORG);
    expect(body.framework).toBe("owasp-llm");
  });

  it("throws an actionable error when orgId is missing", () => {
    expect(() => complianceCheckPayload(base, env)).toThrowError(
      /orgId is required.*--org.*EVALGUARD_ORG_ID/s,
    );
  });

  // Audit 2026-07-25: the route's PostBody requires SIX .min(1) fields —
  // orgId, framework, model, provider, systemPrompt, apiKey. The body carried
  // four at best, so Zod 400'd every request before the handler ran and the
  // remote path was DOA for every API-key user.
  it("satisfies every required field of the route's PostBody", () => {
    const body = complianceCheckPayload({ ...base, orgId: ORG }, env);
    for (const field of [
      "orgId",
      "framework",
      "model",
      "provider",
      "systemPrompt",
      "apiKey",
    ] as const) {
      expect(typeof body[field], `missing ${field}`).toBe("string");
      expect(body[field].length, `empty ${field}`).toBeGreaterThan(0);
    }
  });

  it("never emits an undefined field (JSON.stringify would drop it)", () => {
    const body = complianceCheckPayload({ framework: "hipaa", threshold: 70, orgId: ORG }, env);
    // model/systemPrompt omitted by the caller — they must still be sent.
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.systemPrompt.length).toBeGreaterThan(0);
  });

  it("derives the provider from the model and picks up that provider's key", () => {
    const body = complianceCheckPayload(
      { framework: "hipaa", threshold: 70, orgId: ORG, model: "claude-opus-4-8" },
      { ANTHROPIC_API_KEY: "sk-ant-test" } as NodeJS.ProcessEnv,
    );
    expect(body.provider).toBe("anthropic");
    expect(body.apiKey).toBe("sk-ant-test");
  });

  it("throws an actionable error when the provider credential is absent", () => {
    expect(() =>
      complianceCheckPayload({ ...base, orgId: ORG }, {} as NodeJS.ProcessEnv),
    ).toThrowError(/OPENAI_API_KEY/);
  });

  it("providerApiKeyEnvVar covers the known providers and falls back sanely", () => {
    expect(providerApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
    expect(providerApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerApiKeyEnvVar("cohere")).toBe("COHERE_API_KEY");
  });
});

describe("normalizeRemoteResult (cli-compliance-response-envelope)", () => {
  // The route responds `{success, data: ComplianceCheckResult}` and the engine
  // names fields differently from the CLI renderer. Casting the envelope
  // straight to ComplianceResult made every printed field `undefined` and the
  // verdict `undefined >= threshold` → always FAILED, exit 1.
  const engineResult = {
    framework: "hipaa",
    frameworkName: "HIPAA (AI)",
    overallScore: 75,
    totalRequirements: 4,
    timestamp: "2026-07-25T00:00:00.000Z",
    requirementResults: [
      { requirementId: "R1", category: "privacy", title: "PHI handling", status: "met", score: 100, findings: [] },
      { requirementId: "R2", category: "privacy", title: "Minimum necessary", status: "not-met", score: 0, findings: ["leaked PHI"] },
      { requirementId: "R3", category: "audit", title: "Audit trail", status: "partial", score: 50, findings: [] },
      { requirementId: "R4", category: "audit", title: "Retention", status: "untested", score: 0, findings: [] },
    ],
    remediationPlan: [
      { requirementId: "R2", priority: "critical", action: "Redact PHI", effort: "medium" },
    ],
  };

  it("maps the engine result onto the fields the report renders", () => {
    const r = normalizeRemoteResult(engineResult, "gpt-4o");
    expect(r.overallScore).toBe(75);
    expect(r.model).toBe("gpt-4o");
    expect(r.frameworkName).toBe("HIPAA (AI)");
    expect(r.metCount).toBe(1);
    expect(r.notMetCount).toBe(1);
    expect(r.partialCount).toBe(1);
    expect(r.untestedCount).toBe(1);
    expect(r.totalRequirements).toBe(4);
    expect(r.requirements.map((x) => x.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(r.requirements[1]!.notes).toBe("leaked PHI");
    expect(r.requirements[1]!.severity).toBe("critical");
  });

  it("groups requirements by category with per-category scores", () => {
    const r = normalizeRemoteResult(engineResult, "gpt-4o");
    expect(r.byCategory.privacy).toMatchObject({ total: 2, met: 1, notMet: 1, score: 50 });
    expect(r.byCategory.audit).toMatchObject({ total: 2, partial: 1, untested: 1, score: 0 });
  });

  it("maps the remediation plan, resolving requirement titles", () => {
    const r = normalizeRemoteResult(engineResult, "gpt-4o");
    expect(r.remediationSteps).toHaveLength(1);
    expect(r.remediationSteps[0]).toMatchObject({
      priority: 1,
      requirementId: "R2",
      requirementTitle: "Minimum necessary",
      severity: "critical",
      action: "Redact PHI",
    });
  });

  it("degrades to zeros rather than undefined on an empty payload", () => {
    const r = normalizeRemoteResult({}, "gpt-4o");
    expect(r.overallScore).toBe(0);
    expect(r.totalRequirements).toBe(0);
    expect(r.requirements).toEqual([]);
    expect(Number.isFinite(r.overallScore)).toBe(true);
  });
});
