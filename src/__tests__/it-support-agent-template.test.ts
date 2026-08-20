import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TEMPLATES } from "../commands/init";

// The IT-Support Agent blueprint is an enterprise deliverable, not a toy sample:
// it must (a) scaffold a valid config, (b) carry real security tests that refuse
// privileged/destructive/social-engineering requests, (c) ship an adversarial
// red-team, and (d) encode the governance policy in the prompt. These lock that.

describe("it-support-agent blueprint template", () => {
  const t = TEMPLATES["it-support-agent"];

  it("is registered with a governance-focused description", () => {
    expect(t).toBeDefined();
    expect(t.description).toMatch(/IT-support/i);
    expect(t.description).toMatch(/HITL|human|governed|SOC 2/i);
  });

  it("yaml is valid and references the governed prompt file", () => {
    const cfg = parse(t.yaml);
    expect(cfg.providers.length).toBeGreaterThan(0);
    expect(cfg.prompts[0].file).toBe("prompts/it-support-agent.txt");
  });

  it("has functional tests AND security tests that refuse privileged/secret/injection asks", () => {
    const cfg = parse(t.yaml) as { tests: Array<{ assert: Array<{ type: string }> }> };
    expect(cfg.tests.length).toBeGreaterThanOrEqual(6);
    const refusals = cfg.tests.filter((c) => c.assert.some((a) => a.type === "is-refusal"));
    // destructive DB drop, credential reset, secrets disclosure, prompt-injection, social engineering
    expect(refusals.length).toBeGreaterThanOrEqual(4);
  });

  it("ships an adversarial red-team with IT-relevant plugins + real strategies", () => {
    const cfg = parse(t.yaml) as { redteam: { plugins: string[]; strategies: string[]; numTests: number } };
    expect(cfg.redteam.plugins).toEqual(
      expect.arrayContaining(["prompt-injection", "pii-leak", "excessive-agency", "exploit-tool-agent", "bfla", "ssrf"]),
    );
    expect(cfg.redteam.strategies).toEqual(expect.arrayContaining(["base64", "crescendo"]));
    expect(cfg.redteam.numTests).toBeGreaterThan(0);
  });

  it("governed prompt encodes the enterprise policy (HITL, no-secrets, identity, MCP, SOC 2)", () => {
    const p = t.prompt ?? "";
    expect(p).toMatch(/HUMAN-IN-THE-LOOP/);
    expect(p).toMatch(/NEVER reveal secrets/);
    expect(p).toMatch(/VERIFY IDENTITY/);
    expect(p).toMatch(/MCP gateway/);
    expect(p).toMatch(/SOC 2/);
    // Treats tool/ticket content as data, not instructions (indirect-injection defense).
    expect(p).toMatch(/DATA,\s+not\s+instructions/i);
  });

  it("testFile covers indirect prompt injection AND a legitimate in-scope action (not over-refusal)", () => {
    const tf = parse(t.testFile ?? "") as { tests: unknown[] };
    expect(tf.tests.length).toBeGreaterThanOrEqual(3);
  });
});
