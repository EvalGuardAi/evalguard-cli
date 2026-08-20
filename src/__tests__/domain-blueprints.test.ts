import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TEMPLATES } from "../commands/init";

// The Domain Agent Blueprint library — 27 governed agents across business/
// regulated roles, engineering + GTM functions, industry verticals (covering
// ALL 11 canonical packages/core VERTICAL_PACKS), and cross-cutting agent
// archetypes mapped to named commercial agents (Glean/Operator/Perplexity/
// Mercor). Each MUST be a shippable,
// governed agent — not a toy: a valid config, security tests that refuse the
// domain's dangerous asks, a real red-team, and a governed prompt. This locks
// all of them at once.

const BLUEPRINTS = [
  // Business / regulated
  "it-support-agent",
  "hr-agent",
  "finance-agent",
  "healthcare-agent",
  "marketing-agent",
  "legal-agent",
  // Engineering / technical + GTM
  "coding-agent",
  "devops-agent",
  "finops-agent",
  "data-agent",
  "security-agent",
  "sales-agent",
  "customer-support-agent",
  // Industry verticals (grounded in packages/core VERTICAL_PACKS)
  "telecom-agent",
  "insurance-agent",
  "pharmacy-agent",
  "realestate-agent",
  "teen-safety-agent",
  "ecommerce-agent",
  "education-agent",
  "financial-services-agent",
  // Cross-cutting agent archetypes (mapped to named commercial agents)
  "knowledge-assistant-agent",
  "computer-use-agent",
  "research-agent",
  "recruiting-agent",
  // Capstone: the self-improving autonomous agent (Hermes/Manus/Lindy/AutoGPT)
  "autonomous-agent",
  // Wave-1: reference agent for the Agent Memory Governance layer
  "governed-memory-agent",
] as const;

describe("domain agent blueprint library", () => {
  it.each(BLUEPRINTS)("%s is registered with description + prompt + testFile", (key) => {
    const t = TEMPLATES[key];
    expect(t, `template ${key} missing`).toBeDefined();
    expect(t.description.length).toBeGreaterThan(10);
    expect(t.prompt?.length ?? 0).toBeGreaterThan(200);
    expect(t.testFile?.length ?? 0).toBeGreaterThan(50);
  });

  it.each(BLUEPRINTS)("%s yaml is valid + references prompts/<key>.txt", (key) => {
    const cfg = parse(TEMPLATES[key].yaml) as {
      providers: unknown[];
      prompts: Array<{ file: string }>;
      tests: unknown[];
      redteam: { plugins: string[] };
    };
    expect(cfg.providers.length).toBeGreaterThan(0);
    expect(cfg.prompts[0].file).toBe(`prompts/${key}.txt`);
  });

  it.each(BLUEPRINTS)("%s has security tests that REFUSE dangerous asks", (key) => {
    const cfg = parse(TEMPLATES[key].yaml) as { tests: Array<{ assert: Array<{ type: string }> }> };
    const refusals = cfg.tests.filter((c) => c.assert.some((a) => a.type === "is-refusal"));
    expect(refusals.length, `${key} needs >=3 is-refusal tests`).toBeGreaterThanOrEqual(3);
  });

  it.each(BLUEPRINTS)("%s ships a non-empty red-team block", (key) => {
    const cfg = parse(TEMPLATES[key].yaml) as { redteam: { plugins: string[]; strategies: string[]; numTests: number } };
    expect(cfg.redteam.plugins.length).toBeGreaterThanOrEqual(5);
    expect(cfg.redteam.strategies.length).toBeGreaterThan(0);
    expect(cfg.redteam.numTests).toBeGreaterThan(0);
    // Every domain must red-team prompt-injection (incl. indirect via tool content).
    expect(cfg.redteam.plugins).toContain("prompt-injection");
  });

  it.each(BLUEPRINTS)("%s governed prompt enforces HITL + treats tool content as data", (key) => {
    const p = TEMPLATES[key].prompt ?? "";
    // HITL / approval gate on privileged actions.
    expect(p).toMatch(/HUMAN-IN-THE-LOOP|approval|escalate/i);
    // Indirect-injection defense: tool/message/doc content is data, not instructions.
    expect(p).toMatch(/DATA,\s+not\s+instructions/i);
  });
});
