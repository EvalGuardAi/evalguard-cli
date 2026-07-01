// @vitest-environment node
//
// Regression: per-case `assert: {type, value}` values must NOT collide.
//
// A real-user smoke (echo provider) found that two cases each carrying their
// OWN per-case assert value — case A `{type: contains, value: "alpha"}`, case B
// `{type: contains, value: "beta"}` — collapsed into a single GLOBAL
// `scorerOptions.contains.substring`. The last-seeded value won, so the runner
// applied the WRONG value to the other case and that case scored 0.00 ("No
// expected string provided"). This breaks the exact promptfoo-migration flow
// the docs promote (per-case asserts).
//
// The fix gives each case its OWN per-case scorer-options map
// (`caseScorerOptions`), threaded to the runner where it overrides the shared
// map for that case only. A scorer that reads its reference ONLY from
// `ctx.expected` (equals/similar) rides on the case's `expectedOutput`. Either
// way the values can never overwrite each other. These tests prove:
//   (1) normaliseConfig attaches each case's value under its OWN per-case map;
//   (2) value-based per-case asserts do NOT pollute the shared scorerOptions map;
//   (3) end-to-end through runEvaluation + the echo provider, each case scores
//       against its OWN value (no collision, correct pass/fail);
//   (4) a single case can carry DIFFERENT values for DIFFERENT value-based
//       scorers (contains + similar) — impossible via one expectedOutput slot.
import { describe, expect, it } from "vitest";
import { normaliseConfig } from "../commands/eval-local";
import { runEvaluation, createProvider } from "@evalguard/core";

/** Echo provider call: the model output is the prompt verbatim. */
function echoCallLLM() {
  const provider = createProvider("echo", "");
  return async (prompt: string): Promise<string> => {
    const res = await provider.chat([{ role: "user", content: prompt }], { model: "echo" });
    return res.content;
  };
}

describe("eval-local — per-case assert values don't collide (normaliseConfig)", () => {
  it("threads each Promptfoo-style case's contains value onto its OWN per-case map", () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        { vars: { text: "the alpha wolf" }, assert: [{ type: "contains", value: "alpha" }] },
        { vars: { text: "the beta fish" }, assert: [{ type: "contains", value: "beta" }] },
      ],
    });
    expect(cfg.cases).toHaveLength(2);
    // Each case carries ITS OWN substring — not a shared/last-wins value.
    expect(cfg.cases[0].caseScorerOptions?.contains?.substring).toBe("alpha");
    expect(cfg.cases[1].caseScorerOptions?.contains?.substring).toBe("beta");
  });

  it("does NOT seed a value-based per-case assert into the shared scorerOptions map", () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        { vars: { text: "the alpha wolf" }, assert: [{ type: "contains", value: "alpha" }] },
        { vars: { text: "the beta fish" }, assert: [{ type: "contains", value: "beta" }] },
      ],
    });
    // The collision came from a global `scorerOptions.contains.substring`. With
    // the fix, value-based per-case asserts live on the per-case map and never
    // touch the shared map (so there is nothing to collide).
    expect(cfg.scorerOptions ?? {}).not.toHaveProperty("contains");
  });

  it("threads per-case asserts on the EvalGuard-native ({input}) shape too", () => {
    const cfg = normaliseConfig({
      model: "echo",
      prompt: "{{input}}",
      scorers: ["contains"],
      cases: [
        { input: "hello alpha", assert: [{ type: "contains", value: "alpha" }] },
        { input: "hello beta", assert: [{ type: "contains", value: "beta" }] },
      ],
    });
    expect(cfg.cases[0].caseScorerOptions?.contains?.substring).toBe("alpha");
    expect(cfg.cases[1].caseScorerOptions?.contains?.substring).toBe("beta");
  });

  it("routes equals/similar (which read ctx.expected only) onto the case's expectedOutput", () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        { vars: { text: "Paris" }, assert: [{ type: "equals", value: "Paris" }] },
        { vars: { text: "Tokyo" }, assert: [{ type: "similar", value: "Tokyo" }] },
      ],
    });
    expect(cfg.cases[0].expectedOutput).toBe("Paris");
    expect(cfg.cases[1].expectedOutput).toBe("Tokyo");
  });

  it("lets a SINGLE case carry different values for different value-based scorers", () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        {
          vars: { text: "a beautiful sunny day" },
          assert: [
            { type: "contains", value: "sunny" },
            { type: "similar", value: "a beautiful sunny day" },
          ],
        },
      ],
    });
    // contains → per-case option; similar → per-case expectedOutput. Both held.
    expect(cfg.cases[0].caseScorerOptions?.contains?.substring).toBe("sunny");
    expect(cfg.cases[0].expectedOutput).toBe("a beautiful sunny day");
  });

  it("an explicit expectedOutput always wins over a derived assert value", () => {
    const cfg = normaliseConfig({
      model: "echo",
      prompt: "{{input}}",
      scorers: ["equals"],
      cases: [
        // expectedOutput set AND an equals assert value present → explicit wins.
        { input: "hello world", expectedOutput: "world", assert: [{ type: "equals", value: "alpha" }] },
      ],
    });
    expect(cfg.cases[0].expectedOutput).toBe("world");
  });

  it("maps contains-any array values onto the per-case `values` option", () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        { vars: { text: "alpha gamma" }, assert: [{ type: "contains-any", value: ["alpha", "delta"] }] },
      ],
    });
    expect(cfg.cases[0].caseScorerOptions?.["contains-any"]?.values).toEqual(["alpha", "delta"]);
  });
});

describe("eval-local — per-case assert values don't collide (end-to-end via runEvaluation + echo)", () => {
  it("scores each case against its OWN value — both pass, no 0.00 collision", async () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        { vars: { text: "the alpha wolf" }, assert: [{ type: "contains", value: "alpha" }] },
        { vars: { text: "the beta fish" }, assert: [{ type: "contains", value: "beta" }] },
      ],
    });
    const result = await runEvaluation({
      model: cfg.model,
      prompt: cfg.prompt,
      cases: cfg.cases,
      scorers: cfg.scorers,
      callLLM: echoCallLLM(),
      scorerOptions: cfg.scorerOptions,
    });
    // Before the fix, case A scored 0.00 (global value overwritten to "beta").
    expect(result.cases[0].score).toBe(1);
    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[1].score).toBe(1);
    expect(result.cases[1].passed).toBe(true);
    expect(result.passRate).toBe(1);
  });

  it("still FAILS a case whose own value is absent from its output (no false positives)", async () => {
    const cfg = normaliseConfig({
      prompts: ["{{text}}"],
      tests: [
        { vars: { text: "the alpha wolf" }, assert: [{ type: "contains", value: "alpha" }] },
        { vars: { text: "the gamma ray" }, assert: [{ type: "contains", value: "NOTPRESENT" }] },
      ],
    });
    const result = await runEvaluation({
      model: cfg.model,
      prompt: cfg.prompt,
      cases: cfg.cases,
      scorers: cfg.scorers,
      callLLM: echoCallLLM(),
      scorerOptions: cfg.scorerOptions,
    });
    expect(result.cases[0].passed).toBe(true); // output contains "alpha"
    expect(result.cases[1].passed).toBe(false); // output lacks "NOTPRESENT"
    expect(result.passRate).toBe(0.5);
  });
});
