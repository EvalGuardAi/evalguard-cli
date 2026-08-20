import { describe, it, expect } from "vitest";
import { runEvaluation } from "@evalguard/core";
import { normaliseConfig, runScopedEvaluation } from "../eval-local.js";

/*
 * Regression for the `evalguard eval:local` per-case scorer cross-application
 * bug (live E2E audit 2026-07-15). normaliseConfig used to fold every case's
 * `assert:` block into ONE global scorer list that ran against EVERY case, so a
 * case that declared only `contains` also had `equals` run against it → a
 * phantom `0.00 "No expected string provided"` deflated the score (and every
 * case's score, since the wrong scorers cross-applied both ways). The fix scopes
 * each case to its OWN assert block; these tests prove a case runs only its own
 * scorer type. We test the pure normaliser + `runScopedEvaluation` directly (the
 * `.action()` wrapper calls process.exit, which would hijack the runner).
 */
describe("eval:local per-case scorer scoping (E2E-audit 2026-07-15)", () => {
  const twoTypeConfig = () =>
    normaliseConfig({
      model: "gpt-4o-mini",
      provider: "echo",
      prompt: "{{input}}",
      cases: [
        { input: "alpha-here", assert: [{ type: "contains", value: "alpha" }] },
        { input: "beta-exact", assert: [{ type: "equals", value: "beta-exact" }] },
      ],
    });

  it("normaliseConfig scopes each case's scorers to its OWN assert block", () => {
    const config = twoTypeConfig();
    // Each case carries ONLY the scorer type it declared…
    expect(config.cases[0].caseScorers).toEqual(["contains"]);
    expect(config.cases[1].caseScorers).toEqual(["equals"]);
    // …while the top-level UNION still lists both (banner / validate / summary).
    expect(new Set(config.scorers)).toEqual(new Set(["contains", "equals"]));
  });

  it("runs each case with only its own scorer — no cross-applied phantoms", async () => {
    const config = twoTypeConfig();
    // echo-style model: return the (already-interpolated) prompt verbatim.
    const result = await runScopedEvaluation(runEvaluation, {
      model: config.model,
      prompt: config.prompt,
      cases: config.cases,
      scorers: config.scorers,
      callLLM: async (prompt: string) => prompt,
      scorerOptions: config.scorerOptions,
      cache: false,
    });

    expect(result.cases).toHaveLength(2);
    // Case A ran ONLY `contains` (NOT `equals`); Case B ran ONLY `equals`.
    expect(Object.keys(result.cases[0].scorerResults ?? {})).toEqual(["contains"]);
    expect(Object.keys(result.cases[1].scorerResults ?? {})).toEqual(["equals"]);
    // Order preserved, and NO phantom fail — both cases pass (before the fix
    // both failed on the cross-applied scorer → 0% instead of 100%).
    expect(result.cases[0].input).toContain("alpha");
    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[1].passed).toBe(true);
    expect(result.passRate).toBe(1);
    expect(result.score).toBe(2);
    expect(result.maxScore).toBe(2);
  });

  it("a no-assert case runs only the (empty) global set, never a sibling's type", async () => {
    // With NO top-level/global scorers, the assertion-free case must run ZERO
    // scorers — not inherit the sibling's `contains` via the run-level union.
    const config = normaliseConfig({
      model: "gpt-4o-mini",
      provider: "echo",
      prompt: "{{input}}",
      cases: [
        { input: "has alpha", assert: [{ type: "contains", value: "alpha" }] },
        { input: "no assertions here" },
      ],
    });
    expect(config.cases[0].caseScorers).toEqual(["contains"]);
    expect(config.cases[1].caseScorers).toEqual([]); // global-only (empty)

    const result = await runScopedEvaluation(runEvaluation, {
      model: config.model,
      prompt: config.prompt,
      cases: config.cases,
      scorers: config.scorers,
      callLLM: async (prompt: string) => prompt,
      scorerOptions: config.scorerOptions,
      cache: false,
    });
    expect(Object.keys(result.cases[0].scorerResults ?? {})).toEqual(["contains"]);
    // No `contains` phantom cross-applied onto the assertion-free case.
    expect(Object.keys(result.cases[1].scorerResults ?? {})).toEqual([]);
  });

  it("keeps the single-set fast path (all cases same scorer) unchanged", async () => {
    const config = normaliseConfig({
      model: "gpt-4o-mini",
      provider: "echo",
      prompt: "{{input}}",
      cases: [
        { input: "alpha one", assert: [{ type: "contains", value: "alpha" }] },
        { input: "alpha two", assert: [{ type: "contains", value: "alpha" }] },
      ],
    });
    const result = await runScopedEvaluation(runEvaluation, {
      model: config.model,
      prompt: config.prompt,
      cases: config.cases,
      scorers: config.scorers,
      callLLM: async (prompt: string) => prompt,
      scorerOptions: config.scorerOptions,
      cache: false,
    });
    expect(result.cases).toHaveLength(2);
    expect(Object.keys(result.cases[0].scorerResults ?? {})).toEqual(["contains"]);
    expect(Object.keys(result.cases[1].scorerResults ?? {})).toEqual(["contains"]);
    expect(result.passRate).toBe(1);
  });
});
