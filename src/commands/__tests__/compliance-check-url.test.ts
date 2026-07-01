import { describe, it, expect } from "vitest";
import { complianceCheckUrl, complianceCheckPayload } from "../compliance-check.js";
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

  it("includes orgId in the body so the route's Zod schema accepts it", () => {
    const orgId = "11111111-2222-3333-4444-555555555555";
    const body = complianceCheckPayload({ ...base, orgId });
    // The regression: the old body was { framework, model, systemPrompt } with
    // no orgId, which the route's `orgId: z.string().uuid()` rejected (400).
    expect(body.orgId).toBe(orgId);
    expect(body.framework).toBe("owasp-llm");
  });

  it("throws an actionable error when orgId is missing", () => {
    expect(() => complianceCheckPayload(base)).toThrowError(
      /orgId is required.*--org.*EVALGUARD_ORG_ID/s,
    );
  });
});
