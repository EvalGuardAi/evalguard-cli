// Real-world fixture integration tests for both `import:promptfoo` and
// `import:humanloop`. Closes the "never tested against a real config"
// gap from the session self-audit.
//
// Fixtures use shapes captured verbatim from each vendor's public
// docs/examples — when either vendor ships a schema-shift, this file
// will fail loud and the importer can be updated in lockstep.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { convertPromptfooConfig } from "../commands/import-promptfoo";
import { convertHumanloopExport } from "../commands/import-humanloop";
import { normaliseConfig } from "../commands/eval-local";
import { BUILT_IN_SCORERS } from "@evalguard/core";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

// We import the `yaml` package via dynamic import in the real CLI; for
// the test we use it synchronously since fixtures are tiny.
function loadYamlSync(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(content);
  } catch {
    // Tests run with `yaml` package available as devDep on @evalguard/cli.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yamlMod = require("yaml") as { parse(s: string): unknown };
    return yamlMod.parse(content) as Record<string, unknown>;
  }
}

describe("convertPromptfooConfig — real-world fixture", () => {
  const fixture = loadYamlSync(path.join(FIXTURES_DIR, "real-promptfoo-config.yaml"));
  const result = convertPromptfooConfig(fixture);

  it("parses the real promptfoo config without crashing", () => {
    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
  });

  it("extracts the description as the EvalGuard config name", () => {
    expect(result.config.name).toBe("Tweet sentiment + safety eval");
  });

  it("dedupes + maps 3 providers (including azureopenai → azure rename)", () => {
    expect(result.config.providers).toHaveLength(3);
    expect(result.config.providers.map((p) => p.provider)).toEqual([
      "openai",
      "openai",
      "azure",
    ]);
    expect(result.config.providers.map((p) => p.model)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o",
    ]);
  });

  it("strips apiKey from the gpt-4o-mini config block (no leak)", () => {
    const mini = result.config.providers.find((p) => p.model === "gpt-4o-mini");
    expect(mini?.config).toEqual({ temperature: 0.3, max_tokens: 300 });
    expect(mini?.config).not.toHaveProperty("apiKey");
  });

  it("propagates defaultTest assertions to defaultScorers", () => {
    expect(result.config.defaultScorers).toHaveLength(2);
    expect(result.config.defaultScorers?.[0]).toMatchObject({ scorer: "not-contains" });
    expect(result.config.defaultScorers?.[1]).toMatchObject({ scorer: "toxicity", threshold: 0.1 });
  });

  it("converts 4 test cases (including one with unsupported assertions)", () => {
    expect(result.caseCount).toBe(4);
    expect(result.config.cases).toHaveLength(4);
  });

  it("preserves test.description on each case", () => {
    const c = result.config.cases?.[0] as Record<string, unknown>;
    expect(c.description).toBe("Happy path — neutral topic");
  });

  it("preserves threshold + value on `similar` assertion (semantic-similarity)", () => {
    const happyCase = result.config.cases?.[0] as Record<string, unknown>;
    const scorers = happyCase.scorers as Array<{ scorer: string; value?: unknown; threshold?: number }>;
    const sim = scorers.find((s) => s.scorer === "semantic-similarity");
    expect(sim).toEqual({ scorer: "semantic-similarity", value: "A beautiful sunny day", threshold: 0.6 });
  });

  it("flags unsupported assertions (javascript, rouge) in unmappedAssertions", () => {
    expect(result.unmappedAssertions).toEqual(["javascript", "rouge"]);
  });

  it("maps is-refusal correctly (built-in promptfoo type)", () => {
    const adversarialCase = result.config.cases?.[1] as Record<string, unknown>;
    const scorers = adversarialCase.scorers as Array<{ scorer: string }>;
    expect(scorers.some((s) => s.scorer === "is-refusal")).toBe(true);
  });
});

// The `eval:local <promptfooconfig.yaml>` on-ramp routes the parsed
// Promptfoo config through `normaliseConfig` (NOT the import:promptfoo
// converter). This is the path the migration doc tells users to run, and
// it must map Promptfoo assertion `type`s the SAME way the converter does
// — otherwise `llm-rubric` (etc.) would hit the "Unknown scorers" warning
// and be silently dropped. These tests assert that real-world parity.
describe("normaliseConfig — real-world promptfoo fixture (eval:local on-ramp)", () => {
  const fixture = loadYamlSync(path.join(FIXTURES_DIR, "real-promptfoo-config.yaml"));
  const cfg = normaliseConfig(fixture);

  it("maps promptfoo `llm-rubric` to the `llm-grader` scorer (not left verbatim, not dropped)", () => {
    expect(cfg.scorers).toContain("llm-grader");
    expect(cfg.scorers).not.toContain("llm-rubric");
  });

  it("maps promptfoo `similar` to the `semantic-similarity` scorer", () => {
    expect(cfg.scorers).toContain("semantic-similarity");
    // The fixture's only `similar` is a Promptfoo assertion `type`, so it
    // must be mapped — not passed through as the (also-valid) native
    // `similar` scorer name.
    expect(cfg.scorers).not.toContain("similar");
  });

  it("carries the deterministic assertion types through (contains/not-contains/is-refusal/toxicity/bias)", () => {
    for (const expected of ["contains", "not-contains", "is-refusal", "toxicity", "bias"]) {
      expect(cfg.scorers).toContain(expected);
    }
  });

  it("does NOT emit promptfoo-only types (javascript/rouge) as bogus scorer names", () => {
    expect(cfg.scorers).not.toContain("javascript");
    expect(cfg.scorers).not.toContain("rouge");
  });

  it("surfaces the promptfoo-only types as skippedAssertions with suggestions (warned, not silent)", () => {
    const skipped = cfg.skippedAssertions ?? [];
    const types = skipped.map((s) => s.type).sort();
    expect(types).toEqual(["javascript", "rouge"]);
    // Every skipped entry carries a concrete next-step suggestion.
    for (const entry of skipped) {
      expect(entry.suggestion.length).toBeGreaterThan(0);
    }
    const rouge = skipped.find((s) => s.type === "rouge");
    expect(rouge?.suggestion).toMatch(/semantic-similarity/);
  });

  it("every mapped standard type resolves to a VALID built-in scorer (no 'Unknown scorers' for them)", () => {
    // The promptfoo-only types were excluded above; what remains in the
    // scorer list must all be real registry entries. If any standard
    // mappable type resolved to a non-existent name, this fails — that's
    // exactly the silent-drop bug this change fixes.
    const unknown = cfg.scorers.filter((s) => !BUILT_IN_SCORERS[s]);
    expect(unknown).toEqual([]);
  });

  it("keys PER-CASE assert options under the MAPPED scorer name on the OWNING case (no cross-case collision)", () => {
    // The fixture's `llm-rubric` and `similar` are PER-CASE asserts on the
    // first test case ('Happy path'). Per-case assert values must NOT leak into
    // the SHARED scorerOptions map (that was the collision bug where case A's
    // value overwrote case B's). They live on the owning case's per-case
    // channel instead, keyed under the MAPPED scorer name.
    const happyCase = cfg.cases[0] as {
      caseScorerOptions?: Record<string, Record<string, unknown>>;
      expectedOutput?: string;
    };

    // `llm-rubric`'s `value` maps to `llm-grader`'s `rubric` option, ON the case.
    expect(happyCase.caseScorerOptions?.["llm-grader"]).toMatchObject({
      rubric: "should be a complete tweet",
    });
    // Neither the raw `llm-rubric` nor the mapped name pollutes the shared map.
    expect(cfg.scorerOptions ?? {}).not.toHaveProperty("llm-rubric");
    expect(cfg.scorerOptions ?? {}).not.toHaveProperty("llm-grader");

    // `similar` → `semantic-similarity`, whose reference text reads ONLY from
    // `ctx.expected`, so it rides on the case's `expectedOutput` (per case).
    expect(happyCase.expectedOutput).toBe("A beautiful sunny day");
    expect(cfg.scorerOptions ?? {}).not.toHaveProperty("semantic-similarity");
    expect(cfg.scorerOptions ?? {}).not.toHaveProperty("similar");
  });

  it("keeps GLOBAL defaultTest.assert values in the SHARED map (they apply to every case)", () => {
    // `defaultTest.assert`'s `not-contains: 'I cannot'` is global and
    // legitimately seeds the shared map under the substring key — it is NOT a
    // per-case value, so it must NOT move to a per-case map.
    expect(cfg.scorerOptions?.["not-contains"]).toMatchObject({ substring: "I cannot" });
  });
});

describe("normaliseConfig — assertion mapping is the single ASSERTION_MAP source", () => {
  it("leaves a native EvalGuard `{scorer: ...}` entry untouched (no double-mapping)", () => {
    const cfg = normaliseConfig({
      providers: ["openai:gpt-4o"],
      prompts: ["{{q}}"],
      scorers: [{ scorer: "llm-grader" }, { scorer: "semantic-similarity" }],
      tests: [{ vars: { q: "hi" } }],
    });
    expect(cfg.scorers).toContain("llm-grader");
    expect(cfg.scorers).toContain("semantic-similarity");
  });

  it("leaves a bare-string scorer name untouched", () => {
    const cfg = normaliseConfig({
      model: "echo",
      prompt: "{{input}}",
      cases: [{ input: "hi" }],
      scorers: ["llm-grader"],
    });
    // EvalGuard-native shape short-circuits; the scorer survives verbatim.
    expect(cfg.scorers).toEqual(["llm-grader"]);
  });

  it("maps `is-json` → `json-valid` and `model-graded-fact` → `factuality` via the canonical map", () => {
    const cfg = normaliseConfig({
      providers: ["openai:gpt-4o"],
      prompts: ["{{q}}"],
      tests: [
        {
          vars: { q: "hi" },
          assert: [{ type: "is-json" }, { type: "model-graded-fact" }],
        },
      ],
    });
    expect(cfg.scorers).toContain("json-valid");
    expect(cfg.scorers).toContain("factuality");
    expect(cfg.scorers).not.toContain("is-json");
    expect(cfg.scorers).not.toContain("model-graded-fact");
  });
});

describe("convertHumanloopExport — real-world fixture", () => {
  const fixture = loadYamlSync(path.join(FIXTURES_DIR, "real-humanloop-export.json"));
  const result = convertHumanloopExport(fixture);

  it("parses the real humanloop export without crashing", () => {
    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
  });

  it("uses the project name as the EvalGuard config name", () => {
    expect(result.config.name).toBe("Customer Support Bot");
  });

  it("dedupes + maps 2 distinct providers across 3 prompts", () => {
    // 3 prompts but 2 unique provider:model combos (gpt-4-turbo × 2 + claude-3-5-sonnet × 1)
    expect(result.config.providers).toHaveLength(2);
    expect(result.config.providers.map((p) => p.provider).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("strips ALL three secret-key shapes (api_key, openai_api_key, anthropic_api_key)", () => {
    for (const provider of result.config.providers) {
      const cfg = provider.config ?? {};
      expect(cfg).not.toHaveProperty("api_key");
      expect(cfg).not.toHaveProperty("apiKey");
      expect(cfg).not.toHaveProperty("openai_api_key");
      expect(cfg).not.toHaveProperty("anthropic_api_key");
      expect(cfg).not.toHaveProperty("azure_api_key");
      expect(cfg).not.toHaveProperty("secret");
      expect(cfg).not.toHaveProperty("token");
    }
  });

  it("preserves temperature + max_tokens on stripped-key providers", () => {
    const openai = result.config.providers.find((p) => p.provider === "openai");
    expect(openai?.config).toMatchObject({ temperature: 0.3 });
    // Note: the project has 2 openai prompts with different temperatures
    // (main_response 0.3, summary 0.0). The first wins via dedup.
  });

  it("migrates 3 prompts as templates", () => {
    expect(result.promptCount).toBe(3);
    expect(result.config.prompts[0]).toContain("{{user_query}}");
    expect(result.config.prompts[1]).toContain("{{user_name}}");
  });

  it("flattens 4 dataset inputs across 2 datasets into 4 cases", () => {
    // real_user_queries has 3 inputs, edge_cases has 1 → 4 total cases
    expect(result.caseCount).toBe(4);
    const cases = result.config.cases as Array<Record<string, unknown>>;
    expect(cases[0].description).toBe("from dataset: real_user_queries");
    expect(cases[3].description).toBe("from dataset: edge_cases");
  });

  it("maps 4 of 6 evaluators (llm, human, factuality, toxicity); flags code + custom as unmapped", () => {
    expect(result.evaluatorCount).toBe(6);
    expect(result.unmappedEvaluators).toEqual(["code", "custom"]);
  });

  it("preserves threshold on factuality + toxicity evaluators", () => {
    const factualityScorer = result.config.defaultScorers?.find((s) => s.scorer === "factuality");
    expect(factualityScorer).toMatchObject({ scorer: "factuality", threshold: 0.8 });
    const toxicityScorer = result.config.defaultScorers?.find((s) => s.scorer === "toxicity");
    expect(toxicityScorer).toMatchObject({ scorer: "toxicity", threshold: 0.1 });
  });
});
