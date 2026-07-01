// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normaliseConfig } from "../commands/eval-local";

describe("eval-local YAML normalisation — transform propagation", () => {
  it("preserves the `transform:` field on a Promptfoo-style case", () => {
    const cfg = normaliseConfig({
      providers: ["openai:gpt-4o"],
      prompts: ["{{question}}"],
      tests: [
        {
          vars: { question: "What is 2+2?" },
          transform: "return output.trim();",
          assert: [{ type: "contains", value: "4" }],
        },
      ],
    });
    expect(cfg.cases).toHaveLength(1);
    expect(cfg.cases[0].transform).toBe("return output.trim();");
  });

  it("preserves the `transform:` field on a native { input } case", () => {
    const cfg = normaliseConfig({
      model: "test",
      prompt: "{{input}}",
      cases: [
        {
          input: "hi",
          transform: "return output.toUpperCase();",
        },
      ],
      scorers: ["contains"],
    });
    expect(cfg.cases[0].transform).toBe("return output.toUpperCase();");
  });

  it("forwards vars to the case (string-coerced) for the transform sandbox", () => {
    const cfg = normaliseConfig({
      providers: ["openai:gpt-4o"],
      prompts: ["{{q}}"],
      tests: [
        {
          vars: { q: "hello", n: 42, flag: true },
          transform: "return vars.n;",
        },
      ],
    });
    expect(cfg.cases[0].vars).toEqual({
      q: "hello",
      n: "42",
      flag: "true",
    });
  });

  it("does NOT set transform when YAML has none (keeps no-overhead path)", () => {
    const cfg = normaliseConfig({
      model: "test",
      prompt: "{{input}}",
      cases: [{ input: "hi" }],
      scorers: ["contains"],
    });
    expect(cfg.cases[0].transform).toBeUndefined();
  });

  it("ignores non-string transform values on the Promptfoo-style path (YAML can hold any type)", () => {
    // Use the Promptfoo-style path (tests:) — the EvalGuard-native
    // early-return path (model + prompt + scorers + cases) trusts
    // its input by design and is NOT sanitized.
    const cfg = normaliseConfig({
      providers: ["openai:gpt-4o"],
      prompts: ["{{q}}"],
      tests: [
        { vars: { q: "a" }, transform: 42 as unknown as string },
        { vars: { q: "b" }, transform: { malicious: "object" } as unknown as string },
        { vars: { q: "c" }, transform: null as unknown as string },
      ],
    });
    for (const c of cfg.cases) {
      expect(c.transform).toBeUndefined();
    }
  });
});
