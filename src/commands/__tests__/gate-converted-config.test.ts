import { describe, it, expect } from "vitest";
import { runEvaluation } from "@evalguard/core";
import { validateGateConfig } from "../gate.js";
import { normaliseConfig, runScopedEvaluation } from "../eval-local.js";
import { convertPromptfooConfig } from "../import-promptfoo.js";

/*
 * Regression for "`gate` can't run a converted config" (live E2E of the
 * migration commands, 2026-07-16). validateGateConfig required a top-level
 * `prompt` (string) + `scorers` (array), but a converted config has `prompts:`
 * (array) + `defaultScorers`/per-case scorers, so `gate cfg.json` failed with
 * "missing prompt". The fix normalises the config (the SAME path eval:local
 * uses) BEFORE validating. These tests prove the normalise→validate→run seam
 * directly (the `.action()` closure calls process.exit).
 */

// A realistic promptfoo config with PER-CASE scorers carrying distinct values —
// the shape that would cross-collide under a single shared scorerOptions map.
const converted = () =>
  convertPromptfooConfig({
    description: "Migration smoke",
    providers: ["openai:gpt-4o-mini"],
    prompts: ["Write a note about {{topic}}"],
    defaultTest: { assert: [{ type: "not-contains", value: "forbidden" }] },
    tests: [
      { vars: { topic: "a sunny day" }, assert: [{ type: "contains", value: "sunny" }] },
      { vars: { topic: "the deep ocean" }, assert: [{ type: "contains", value: "ocean" }] },
    ],
  }).config;

describe("gate runs a converted config (E2E 2026-07-16)", () => {
  it("a converted config passes validateGateConfig AFTER normalisation (was 'missing prompt')", () => {
    // The RAW converted config is rejected by the native-only gate schema…
    const raw = validateGateConfig(converted() as unknown);
    expect(raw.ok).toBe(false);
    // …but normalising it (as the gate now does) yields the native shape it accepts.
    const normalised = normaliseConfig(converted());
    const gated = validateGateConfig(normalised);
    expect(gated.ok).toBe(true);
    if (gated.ok) {
      expect(typeof gated.config.prompt).toBe("string");
      expect(gated.config.prompt.length).toBeGreaterThan(0);
      expect(gated.config.scorers.length).toBeGreaterThan(0);
      expect(gated.config.cases).toHaveLength(2);
    }
  });

  it("runs per-case-scoped with NO cross-case phantom failures (echo provider)", async () => {
    const config = normaliseConfig(converted());
    const result = await runScopedEvaluation(runEvaluation, {
      model: config.model,
      prompt: config.prompt,
      cases: config.cases,
      scorers: config.scorers,
      // echo: return the already-interpolated prompt verbatim.
      callLLM: async (prompt: string) => prompt,
      scorerOptions: config.scorerOptions,
      cache: false,
    });
    // Case 1 ('sunny') and case 2 ('ocean') each pass their OWN `contains` (plus
    // the global `not-contains "forbidden"`). Under a shared options map the two
    // `contains` values would collide and one case would phantom-fail.
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[1].passed).toBe(true);
    expect(result.passRate).toBe(1);
  });

  it("keeps the fail-closed guard: a genuinely empty config is still rejected", () => {
    // A wholly empty config must never yield a runnable gate.
    expect(validateGateConfig(normaliseConfig({})).ok).toBe(false);
  });

  it("keeps the fail-closed guard: prompt + scorers but ZERO cases fails on coverage", () => {
    // normaliseConfig does NOT synthesise cases, so a config with everything
    // except test cases still hits validateGateConfig's zero-coverage guard.
    const normalised = normaliseConfig({ prompt: "Answer {{input}}", scorers: ["contains"], cases: [] });
    const gated = validateGateConfig(normalised);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error).toMatch(/no test cases|zero coverage/i);
  });
});
