// Coverage for import-promptfoo. Bugs class:
//   - Provider colon-split wrong → "openai:gpt-4o" maps to wrong provider
//   - Assertion type table drift → silently breaks customer migrations
//   - apiKey leaks from imported promptfoo config → checked-in secret
//   - `not-` prefix on unknown type → mis-mapped instead of pass-through
//   - Unmapped assertion list dedupe → noise in the summary
//   - Empty source → crash on .map of undefined

import { describe, expect, it } from "vitest";
import {
  ASSERTION_MAP,
  ASSERTION_SUGGESTIONS,
  convertPromptfooConfig,
  mapAssertion,
  mapProvider,
} from "../commands/import-promptfoo";

describe("ASSERTION_MAP", () => {
  it("covers the 24 promptfoo assertion types we promise to migrate", () => {
    const expected = [
      "contains", "not-contains", "icontains", "contains-any", "contains-all",
      "equals", "starts-with", "ends-with", "regex",
      "is-json", "is-valid-openai-function-call",
      "llm-rubric", "model-graded-closedqa", "model-graded-fact", "factuality",
      "answer-relevance", "context-faithfulness", "context-relevance",
      "similar", "cost", "latency", "toxicity", "bias", "is-refusal",
    ];
    for (const t of expected) {
      expect(ASSERTION_MAP[t]).toBeDefined();
    }
  });

  it("has a suggestion for every promptfoo-only type the user might paste", () => {
    // Sanity floor — keep the dictionary populated for the most-
    // referenced unsupported types so users don't get a bare "verbatim".
    expect(ASSERTION_SUGGESTIONS.javascript).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.python).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.webhook).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.rouge).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.bleu).toBeDefined();
  });
});

describe("mapProvider", () => {
  it("parses 'openai:gpt-4o' into { provider:'openai', model:'gpt-4o' }", () => {
    expect(mapProvider("openai:gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("re-labels 'azureopenai' → 'azure' (EvalGuard provider key)", () => {
    expect(mapProvider("azureopenai:gpt-4o")).toEqual({ provider: "azure", model: "gpt-4o" });
  });

  it("preserves colons in the model name (e.g. anthropic:claude-3-5-sonnet:beta)", () => {
    expect(mapProvider("anthropic:claude-3-5-sonnet:beta")).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet:beta",
    });
  });

  it("falls back to provider==model when no colon present", () => {
    // Promptfoo lets you use just a provider name (e.g. 'echo' for the
    // built-in echo provider). We can't infer a model in that case.
    expect(mapProvider("echo")).toEqual({ provider: "echo", model: "echo" });
  });

  it("parses object form { id, config } and strips apiKey", () => {
    const result = mapProvider({
      id: "openai:gpt-4o-mini",
      config: { apiKey: "sk-LEAK_ME", temperature: 0.7, max_tokens: 500 },
    });
    expect(result).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      config: { temperature: 0.7, max_tokens: 500 },
    });
    expect(result.config).not.toHaveProperty("apiKey");
  });

  it("also strips api_key (snake_case variant)", () => {
    const result = mapProvider({
      id: "openai:gpt-4o",
      config: { api_key: "sk-LEAK", model_kwargs: {} },
    });
    expect(result.config).not.toHaveProperty("api_key");
    expect(result.config).toHaveProperty("model_kwargs");
  });

  it("omits the `config` field when only secrets were present", () => {
    const result = mapProvider({ id: "openai:gpt-4o", config: { apiKey: "sk-only" } });
    expect(result).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(result.config).toBeUndefined();
  });

  it("supports the `label` field as an alias for `id` (promptfoo allows this)", () => {
    const result = mapProvider({ label: "anthropic:claude-3-5-haiku-20241022" });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-3-5-haiku-20241022");
  });
});

describe("mapAssertion", () => {
  it("maps a known type to the EvalGuard scorer name", () => {
    expect(mapAssertion({ type: "contains", value: "Paris" })).toEqual({
      scorer: "contains",
      value: "Paris",
    });
  });

  it("preserves the threshold field", () => {
    expect(
      mapAssertion({ type: "semantic-similarity", value: "Paris", threshold: 0.85 }),
    ).toEqual({ scorer: "semantic-similarity", value: "Paris", threshold: 0.85 });
  });

  it("handles the `not-` prefix on a known type via pass-through (not-contains is itself in the map)", () => {
    expect(mapAssertion({ type: "not-contains", value: "Berlin" })).toEqual({
      scorer: "not-contains",
      value: "Berlin",
    });
  });

  it("synthesises `not-<scorer>` for `not-<known>` types not in the map directly", () => {
    // `not-equals` isn't in our map, but `equals` is — we re-prefix.
    expect(mapAssertion({ type: "not-equals", value: "no" })).toEqual({
      scorer: "not-equals",
      value: "no",
    });
  });

  it("passes unknown types through verbatim (the caller flags them)", () => {
    expect(mapAssertion({ type: "javascript", value: "() => true" })).toEqual({
      scorer: "javascript",
      value: "() => true",
      threshold: undefined,
    });
  });

  it("returns null on a malformed assertion with no `type` field", () => {
    expect(mapAssertion({ value: "no type" })).toBeNull();
  });
});

describe("convertPromptfooConfig — full conversion", () => {
  it("converts a minimal real-world promptfoo config", () => {
    const source = {
      description: "Tweet generator regression",
      providers: ["openai:gpt-4o"],
      prompts: ["Write a tweet about {{topic}}"],
      tests: [
        { vars: { topic: "bananas" }, assert: [{ type: "contains", value: "banana" }] },
        { vars: { topic: "AI safety" }, assert: [{ type: "llm-rubric", value: "informative" }] },
      ],
    };
    const result = convertPromptfooConfig(source);
    expect(result.config.name).toBe("Tweet generator regression");
    expect(result.config.providers).toEqual([{ provider: "openai", model: "gpt-4o" }]);
    expect(result.config.prompts).toEqual(["Write a tweet about {{topic}}"]);
    expect(result.caseCount).toBe(2);
    expect(result.unmappedAssertions).toEqual([]);
  });

  it("maps defaultTest.assert into defaultScorers", () => {
    const source = {
      providers: ["openai:gpt-4o"],
      defaultTest: { assert: [{ type: "toxicity" }, { type: "bias" }] },
      tests: [],
    };
    const result = convertPromptfooConfig(source);
    expect(result.config.defaultScorers).toEqual([
      { scorer: "toxicity" },
      { scorer: "bias" },
    ]);
    expect(result.defaultScorerCount).toBe(2);
  });

  it("dedupes unmapped assertion types across all tests", () => {
    const source = {
      providers: ["openai:gpt-4o"],
      tests: [
        { assert: [{ type: "javascript" }, { type: "python" }] },
        { assert: [{ type: "javascript" }, { type: "rouge" }] },
      ],
    };
    const result = convertPromptfooConfig(source);
    expect(result.unmappedAssertions).toEqual(["javascript", "python", "rouge"]);
  });

  it("does NOT flag known `not-` prefixed types as unmapped", () => {
    const source = {
      providers: ["openai:gpt-4o"],
      tests: [{ assert: [{ type: "not-contains", value: "secret" }] }],
    };
    expect(convertPromptfooConfig(source).unmappedAssertions).toEqual([]);
  });

  it("handles empty providers + empty tests without crashing", () => {
    const result = convertPromptfooConfig({});
    expect(result.config.providers).toEqual([]);
    expect(result.config.prompts).toEqual([]);
    expect(result.caseCount).toBe(0);
    expect(result.defaultScorerCount).toBe(0);
    expect(result.unmappedAssertions).toEqual([]);
  });

  it("default name when description is missing", () => {
    const result = convertPromptfooConfig({ providers: [], prompts: [], tests: [] });
    expect(result.config.name).toBe("Imported from Promptfoo");
  });

  it("preserves test.vars and test.description on each case", () => {
    const source = {
      providers: ["openai:gpt-4o"],
      tests: [
        {
          description: "Edge case — empty topic",
          vars: { topic: "" },
          assert: [{ type: "contains", value: "topic" }],
        },
      ],
    };
    const result = convertPromptfooConfig(source);
    const c = result.config.cases?.[0] as Record<string, unknown>;
    expect(c.vars).toEqual({ topic: "" });
    expect(c.description).toBe("Edge case — empty topic");
    expect(c.scorers).toEqual([{ scorer: "contains", value: "topic" }]);
  });

  it("multi-provider config — each provider mapped independently", () => {
    const source = {
      providers: [
        "openai:gpt-4o",
        { id: "anthropic:claude-3-5-sonnet", config: { temperature: 0.3 } },
        "azureopenai:gpt-4o-mini",
      ],
      prompts: [],
      tests: [],
    };
    const result = convertPromptfooConfig(source);
    expect(result.config.providers).toEqual([
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude-3-5-sonnet", config: { temperature: 0.3 } },
      { provider: "azure", model: "gpt-4o-mini" },
    ]);
  });
});
