// Coverage for import-promptfoo. Bugs class:
//   - Provider colon-split wrong → "openai:gpt-4o" maps to wrong provider
//   - Assertion type table drift → silently breaks customer migrations
//   - apiKey leaks from imported promptfoo config → checked-in secret
//   - `not-` prefix on unknown type → mis-mapped instead of pass-through
//   - Unmapped assertion list dedupe → noise in the summary
//   - Empty source → crash on .map of undefined

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ASSERTION_MAP,
  ASSERTION_SUGGESTIONS,
  convertPromptfooConfig,
  loadYaml,
  mapAssertion,
  mapProvider,
} from "../commands/import-promptfoo";

/**
 * Promptfoo's assertion vocabulary — `BaseAssertionTypesSchema` in their
 * src/types/index.ts, commit db03327 (v0.121.17), transcribed in enum order.
 *
 * FROZEN LITERAL ON PURPOSE. Their repo is not a dependency and is not on a CI
 * runner, so the alternative to a transcript is what this file used to do:
 * assert that a hand-written list of names is "defined" in a hand-written map.
 * That is a document checked against a second document — it passed for as long
 * as nobody touched either, and it passed while FOUR of the map's keys were
 * strings Promptfoo has never accepted. Re-transcribe when bumping the pinned
 * commit; the point is that adding a key now requires looking at their enum.
 *
 * `not-<base>` is not listed: they generate it for every base type
 * (`NotPrefixedAssertionTypesSchema`, src/types/index.ts:677), so the check
 * below strips the prefix instead.
 */
const PROMPTFOO_BASE_ASSERTION_TYPES = [
  "agent-rubric", "answer-relevance", "bleu", "classifier", "contains",
  "contains-all", "contains-any", "contains-html", "contains-json",
  "contains-sql", "contains-xml", "context-faithfulness", "context-recall",
  "context-relevance", "conversation-relevance", "cost", "equals", "factuality",
  "finish-reason", "g-eval", "gleu", "guardrails", "icontains", "icontains-all",
  "icontains-any", "is-html", "is-json", "is-refusal", "is-sql",
  "is-valid-function-call", "is-valid-openai-function-call",
  "is-valid-openai-tools-call", "is-xml", "javascript", "latency",
  "levenshtein", "llm-rubric", "pi", "meteor", "model-graded-closedqa",
  "model-graded-factuality", "moderation", "perplexity", "perplexity-score",
  "python", "regex", "rouge-n", "ruby", "similar", "similar:cosine",
  "similar:dot", "similar:euclidean", "starts-with", "tool-call-f1",
  "skill-used", "trajectory:goal-success", "trajectory:tool-args-match",
  "trajectory:step-count", "trajectory:tool-sequence", "trajectory:tool-used",
  "trace-error-spans", "trace-span-count", "trace-span-duration",
  "search-rubric", "webhook", "word-count",
] as const;

/** `SpecialAssertionTypes`, src/types/index.ts:673. */
const PROMPTFOO_SPECIAL_ASSERTION_TYPES = ["select-best", "human", "max-score"] as const;

/**
 * Keys that are deliberately NOT Promptfoo assertion types.
 *
 * Identity pass-throughs to real EvalGuard scorers, kept so an already-migrated
 * or hand-written EvalGuard config carrying these names still resolves. See the
 * note above ASSERTION_MAP. Promptfoo documents that it has no `ends-with`
 * (docs/plans/smoke-tests.md:870 — "There is no `ends-with` assertion type"),
 * and its `toxicity`/`bias` are red-team PLUGIN ids, not assertion types.
 */
const DELIBERATE_NON_PROMPTFOO_KEYS = new Set(["ends-with", "toxicity", "bias"]);

const isRealPromptfooType = (t: string): boolean => {
  const base = t.startsWith("not-") ? t.slice(4) : t;
  return (
    (PROMPTFOO_BASE_ASSERTION_TYPES as readonly string[]).includes(base) ||
    (PROMPTFOO_SPECIAL_ASSERTION_TYPES as readonly string[]).includes(t)
  );
};

// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("ASSERTION_MAP", () => {
  it("keys on strings Promptfoo actually accepts", () => {
    // The defect this closes: `model-graded-fact` and `rouge` were keys, so the
    // entries were unreachable AND the real types `model-graded-factuality` and
    // `rouge-n` fell through unmapped — a silent import gap, never a crash.
    const notReal = Object.keys(ASSERTION_MAP).filter(
      (t) => !isRealPromptfooType(t) && !DELIBERATE_NON_PROMPTFOO_KEYS.has(t),
    );
    expect(notReal).toEqual([]);
  });

  it("suggests only for strings Promptfoo actually accepts", () => {
    const notReal = Object.keys(ASSERTION_SUGGESTIONS).filter((t) => !isRealPromptfooType(t));
    expect(notReal).toEqual([]);
  });

  it("names the real spellings of the two types that were previously missed", () => {
    expect(ASSERTION_MAP["model-graded-factuality"]).toBe("factuality");
    expect(ASSERTION_MAP["rouge-n"]).toBe("rouge-n");
    expect(ASSERTION_MAP["model-graded-fact"]).toBeUndefined();
    expect(ASSERTION_MAP.rouge).toBeUndefined();
  });

  it("resolves every mapped scorer against the real @evalguard/core registry", async () => {
    // The other half of the same class, and the more damaging half: a key can be
    // dead and nothing happens, but a bad VALUE is written into the generated
    // config and only surfaces later as eval:local's "Unknown scorers". `regex`
    // mapped to "regex" (the registry key is `regex-match`) and
    // `is-valid-openai-function-call` mapped to "function-call-valid" (the key
    // is `is-valid-function-call`) — the first of those is the single most
    // common Promptfoo assertion there is.
    const { BUILT_IN_SCORERS } = await import("@evalguard/core");
    const unknown = Object.entries(ASSERTION_MAP)
      .filter(([, scorer]) => !(scorer in BUILT_IN_SCORERS))
      .map(([type, scorer]) => `${type} → ${scorer}`);
    expect(unknown).toEqual([]);
  });

  it("covers the promptfoo assertion types we promise to migrate", () => {
    const expected = [
      "contains", "not-contains", "icontains", "contains-any", "contains-all",
      "equals", "starts-with", "ends-with", "regex",
      "is-json", "is-valid-function-call", "is-valid-openai-function-call",
      "llm-rubric", "model-graded-closedqa", "model-graded-factuality", "factuality",
      "answer-relevance", "context-faithfulness", "context-relevance",
      "similar", "cost", "latency", "toxicity", "bias", "is-refusal",
    ];
    for (const t of expected) {
      expect(ASSERTION_MAP[t]).toBeDefined();
    }
  });

  it("states its Promptfoo coverage rather than implying parity", () => {
    // 29 of 66 base types are named (mapped or suggested). The rest are dropped
    // on import and reported in `unmappedAssertions`. Asserted so the number in
    // the source comment cannot quietly become fiction, and so a future author
    // who widens coverage has to update the claim in the same change.
    //
    // It was 26 before the 2026-08-10 repair: `model-graded-fact` and `rouge`
    // covered nothing (not types), and correcting them plus adding
    // `is-valid-function-call` bought three real ones.
    const named = new Set([
      ...Object.keys(ASSERTION_MAP),
      ...Object.keys(ASSERTION_SUGGESTIONS),
    ]);
    const covered = PROMPTFOO_BASE_ASSERTION_TYPES.filter((t) => named.has(t));
    expect(covered.length).toBe(29);
    expect(PROMPTFOO_BASE_ASSERTION_TYPES.length).toBe(66);
  });

  it("has a suggestion for every promptfoo-only type with no built-in equivalent", () => {
    // Sanity floor — keep the dictionary populated for the most-referenced
    // types that genuinely have NO built-in scorer, so users don't get a bare
    // "verbatim". (bleu/rouge-n/webhook were moved OUT — they DO have equivalents.)
    expect(ASSERTION_SUGGESTIONS.javascript).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.python).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.classifier).toBeDefined();
    expect(ASSERTION_SUGGESTIONS.moderation).toBeDefined();
    expect(ASSERTION_SUGGESTIONS["perplexity-score"]).toBeDefined();
  });

  it("maps bleu/rouge-n/webhook to their real built-in scorers (not flagged 'no equivalent')", () => {
    // Verified against @evalguard/core's registry: keys are `bleu`, `rouge-n`,
    // `webhook`. They belong in the MAP, not the suggestions.
    expect(ASSERTION_MAP.bleu).toBe("bleu");
    expect(ASSERTION_MAP["rouge-n"]).toBe("rouge-n");
    expect(ASSERTION_MAP.webhook).toBe("webhook");
    expect(ASSERTION_SUGGESTIONS.bleu).toBeUndefined();
    expect(ASSERTION_SUGGESTIONS["rouge-n"]).toBeUndefined();
    expect(ASSERTION_SUGGESTIONS.webhook).toBeUndefined();
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

  it("dedupes unmapped assertion types across all tests (rouge-n now maps, drops out)", () => {
    const source = {
      providers: ["openai:gpt-4o"],
      tests: [
        { assert: [{ type: "javascript" }, { type: "python" }] },
        { assert: [{ type: "javascript" }, { type: "rouge-n" }] },
      ],
    };
    const result = convertPromptfooConfig(source);
    // `rouge-n` maps to the built-in `rouge-n`, so only javascript/python remain
    // unmapped — and the mapped `rouge-n` is written as a scorer, not flagged.
    expect(result.unmappedAssertions).toEqual(["javascript", "python"]);
  });

  it("excludes unknown passthrough types from the written scorers (no bogus scorer names)", () => {
    // A case whose ONLY assertions are unknown types emits NO `scorers:` key, so
    // the written config never carries a `scorer: "python"` that would later trip
    // "Unknown scorers"; the mapped `rouge-n`→`rouge-n` on the same case survives.
    const source = {
      providers: ["openai:gpt-4o"],
      tests: [
        { vars: { x: "1" }, assert: [{ type: "python" }] },
        { vars: { x: "2" }, assert: [{ type: "python" }, { type: "rouge-n", value: "ref" }] },
      ],
    };
    const result = convertPromptfooConfig(source);
    const cases = result.config.cases as Array<Record<string, unknown>>;
    expect(cases[0].scorers).toBeUndefined();
    expect(cases[1].scorers).toEqual([{ scorer: "rouge-n", value: "ref" }]);
  });

  it("counts only truly-mapped defaultTest assertions in defaultScorerCount", () => {
    // `python` is unknown → not written, not counted; `bleu` maps → counted.
    const source = {
      providers: ["openai:gpt-4o"],
      defaultTest: { assert: [{ type: "toxicity" }, { type: "python" }, { type: "bleu", value: "ref" }] },
      tests: [],
    };
    const result = convertPromptfooConfig(source);
    expect(result.defaultScorerCount).toBe(2);
    expect(result.config.defaultScorers).toEqual([
      { scorer: "toxicity" },
      { scorer: "bleu", value: "ref" },
    ]);
    expect(result.unmappedAssertions).toEqual(["python"]);
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

describe("loadYaml — surfaces the real parse error, not a bogus 'install yaml' hint", () => {
  // Regression (live E2E 2026-07-16): a malformed YAML file was misreported as
  // "YAML parsing requires the 'yaml' package" even though `yaml` IS installed,
  // because an inner catch swallowed the YAMLParseError. loadYaml must now
  // surface the real parser error (with line/column) when `yaml` is present.
  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-loadyaml-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a valid YAML config", async () => {
    const p = writeTmp("ok.yaml", "description: hi\nproviders:\n  - openai:gpt-4o\n");
    const cfg = await loadYaml(p);
    expect(cfg.description).toBe("hi");
  });

  it("parses a JSON config (JSON is tried first)", async () => {
    const p = writeTmp("ok.json", JSON.stringify({ description: "j" }));
    const cfg = await loadYaml(p);
    expect(cfg.description).toBe("j");
  });

  it("throws the REAL YAMLParseError (line/column), NOT the install hint", async () => {
    // Malformed: two mapping items at mismatched columns → a genuine parse error.
    const p = writeTmp("bad.yaml", "providers:\n  - openai:gpt-4o\n  bad: [unclosed\ntests: : :\n");
    await expect(loadYaml(p)).rejects.toThrow(/Invalid YAML/);
    await expect(loadYaml(p)).rejects.not.toThrow(/requires the 'yaml' package/);
  });
});
