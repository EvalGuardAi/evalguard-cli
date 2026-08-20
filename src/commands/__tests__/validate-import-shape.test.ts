import { describe, it, expect } from "vitest";
import {
  BUILT_IN_SCORERS,
  ATTACK_TYPES,
  ALL_PLUGINS,
  ALL_STRATEGIES,
  ALL_GRADERS,
} from "@evalguard/core";
import { validateConfigObject, type ValidateRegistries } from "../validate.js";
import { convertPromptfooConfig } from "../import-promptfoo.js";
import { convertHumanloopExport } from "../import-humanloop.js";

/*
 * Regression for "`validate` rejects the importers' OWN output" (live E2E of the
 * migration commands, 2026-07-16). `import:promptfoo`/`import:humanloop` write a
 * top-level `defaultScorers` + per-case `cases[].scorers`, but `validate` only
 * recognised top-level `scorers` / per-case `cases[].assert` and reported
 * "Missing 'scorers' field". `import:* <cfg>` → `validate <out>` must now pass.
 */
const registries = {
  BUILT_IN_SCORERS,
  ATTACK_TYPES,
  ALL_PLUGINS,
  ALL_STRATEGIES,
  ALL_GRADERS,
} as unknown as ValidateRegistries;

// validateConfigObject MUTATES its input — round-trip through JSON so each test
// gets a fresh, plain object identical to what the importer writes to disk.
function asWritten(config: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

describe("validate accepts import:promptfoo output (E2E 2026-07-16)", () => {
  const result = convertPromptfooConfig({
    description: "Tweet safety",
    providers: ["openai:gpt-4o-mini"],
    prompts: ["Write a note about {{topic}}"],
    defaultTest: { assert: [{ type: "not-contains", value: "forbidden" }] },
    tests: [
      { vars: { topic: "sun" }, assert: [{ type: "contains", value: "sun" }] },
      { vars: { topic: "sea" }, assert: [{ type: "llm-rubric", value: "on-topic" }] },
    ],
  });

  it("validates the converted config with zero errors", () => {
    const { errors, isEval } = validateConfigObject(asWritten(result.config), registries);
    expect(isEval).toBe(true);
    expect(errors).toEqual([]);
  });

  it("recognizes the top-level `defaultScorers` list", () => {
    const cfg = asWritten({
      prompts: ["{{input}}"],
      defaultScorers: [{ scorer: "toxicity" }, { scorer: "contains", value: "x" }],
      cases: [{ vars: { input: "hi" } }],
    });
    expect(validateConfigObject(cfg, registries).errors).toEqual([]);
  });

  it("recognizes per-case `cases[].scorers` (importer shape) as well as `assert`", () => {
    const cfg = asWritten({
      prompts: ["{{input}}"],
      cases: [{ vars: { input: "hi" }, scorers: [{ scorer: "contains", value: "h" }] }],
    });
    expect(validateConfigObject(cfg, registries).errors).toEqual([]);
  });

  it("still rejects a genuinely unknown scorer in defaultScorers", () => {
    const cfg = asWritten({
      prompts: ["{{input}}"],
      defaultScorers: [{ scorer: "definitely-not-a-scorer" }],
      cases: [{ vars: { input: "hi" } }],
    });
    const { errors } = validateConfigObject(cfg, registries);
    expect(errors.some((e) => /Unknown scorer/.test(e))).toBe(true);
  });
});

describe("validate accepts import:humanloop output (E2E 2026-07-16)", () => {
  const result = convertHumanloopExport({
    name: "Support bot",
    prompts: [
      {
        template: "Answer: {{query}}",
        model_config: { provider: "openai", model: "gpt-4o-mini" },
      },
    ],
    datasets: [{ name: "q", inputs: [{ query: "hi" }, { query: "bye" }] }],
    evaluators: [{ type: "toxicity", threshold: 0.1 }, { type: "factuality", threshold: 0.8 }],
  });

  it("validates the converted config with zero errors", () => {
    const { errors, isEval } = validateConfigObject(asWritten(result.config), registries);
    expect(isEval).toBe(true);
    expect(errors).toEqual([]);
  });
});
