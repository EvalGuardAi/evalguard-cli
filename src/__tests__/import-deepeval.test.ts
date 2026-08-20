// Coverage for import:deepeval. Bug classes:
//   - input → vars mapping wrong → cases lose their variables
//   - context / retrieval_context (RAG grounding) dropped → migrated case breaks
//   - single-key vs multi-key expected_output → `expected` gets wrong reference
//   - api_key / token bleeds from a golden into a checked-in config
//   - malformed export (null / non-array / non-object records) → crash
//   - no reference values → no scorer → config can't validate (must warn)
//   - dry-run vs written config drift

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_PROMPT,
  DEFAULT_REFERENCE_SCORER,
  convertDeepEvalDataset,
  isSecretKey,
  loadDeepEvalFile,
  mapReferenceOutput,
  stripSecrets,
} from "../commands/import-deepeval";

describe("isSecretKey", () => {
  it("flags secret-ish keys (exact + patterned, incl. DeepEval/Confident keys)", () => {
    for (const k of [
      "api_key",
      "apiKey",
      "openai_api_key",
      "anthropic_api_key",
      "confident_api_key",
      "deepeval_api_key",
      "OPENAI_API_KEY",
      "secret",
      "client_secret",
      "token",
      "access_token",
      "refresh_token",
      "authorization",
      "password",
      "private_key",
      "some_vendor_api_key",
    ]) {
      expect(isSecretKey(k)).toBe(true);
    }
  });

  it("does NOT flag benign fields that merely contain 'token'", () => {
    for (const k of ["total_tokens", "prompt_tokens", "completion_tokens", "token_count", "input", "context", "retrieval_context"]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe("stripSecrets", () => {
  it("recursively removes secret keys and records them", () => {
    const removed = new Set<string>();
    const cleaned = stripSecrets(
      {
        question: "hi",
        api_key: "sk-LEAK1",
        nested: { openai_api_key: "sk-LEAK2", temperature: 0.7, deeper: [{ token: "LEAK3", ok: 1 }] },
        prompt_tokens: 5,
      },
      removed,
    );
    expect(cleaned).toEqual({
      question: "hi",
      nested: { temperature: 0.7, deeper: [{ ok: 1 }] },
      prompt_tokens: 5,
    });
    expect([...removed].sort()).toEqual(["api_key", "openai_api_key", "token"]);
  });

  it("leaves primitives untouched", () => {
    const removed = new Set<string>();
    expect(stripSecrets("plain", removed)).toBe("plain");
    expect(stripSecrets(42, removed)).toBe(42);
    expect(removed.size).toBe(0);
  });
});

describe("mapReferenceOutput", () => {
  it("passes a bare string / number / boolean through", () => {
    expect(mapReferenceOutput("Paris")).toBe("Paris");
    expect(mapReferenceOutput(7)).toBe("7");
    expect(mapReferenceOutput(true)).toBe("true");
  });

  it("takes the primary value from a single-key expected object", () => {
    expect(mapReferenceOutput({ answer: "Paris" })).toBe("Paris");
  });

  it("JSON-stringifies a single non-string primary value", () => {
    expect(mapReferenceOutput({ score: 0.9 })).toBe("0.9");
    expect(mapReferenceOutput({ labels: ["a", "b"] })).toBe(JSON.stringify(["a", "b"]));
  });

  it("preserves the whole object when expected has multiple keys", () => {
    expect(mapReferenceOutput({ answer: "Paris", confidence: 0.9 })).toBe(
      JSON.stringify({ answer: "Paris", confidence: 0.9 }),
    );
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(mapReferenceOutput(null)).toBeUndefined();
    expect(mapReferenceOutput(undefined)).toBeUndefined();
    expect(mapReferenceOutput({})).toBeUndefined();
    expect(mapReferenceOutput([])).toBeUndefined();
  });
});

describe("convertDeepEvalDataset — full conversion", () => {
  it("maps goldens → cases with vars=input and expected=expected_output", () => {
    const source = {
      alias: "RAG regression",
      description: "Golden answers for the support bot",
      goldens: [
        { input: "Capital of France?", expected_output: "Paris" },
        { input: "2+2?", expected_output: "4" },
      ],
    };
    const r = convertDeepEvalDataset(source);
    expect(r.config.name).toBe("RAG regression");
    expect(r.config.description).toBe("Golden answers for the support bot");
    expect(r.config.cases).toEqual([
      { vars: { input: "Capital of France?" }, expected: "Paris" },
      { vars: { input: "2+2?" }, expected: "4" },
    ]);
    expect(r.recordCount).toBe(2);
    expect(r.caseCount).toBe(2);
    expect(r.withReferenceCount).toBe(2);
    // A scaffold `{{input}}` prompt is emitted (dataset carries no prompt).
    expect(r.config.prompt).toBe(DEFAULT_PROMPT);
    // Reference values present → runnable default scorer injected.
    expect(r.defaultScorerInjected).toBe(true);
    expect(r.config.defaultScorers).toEqual([{ scorer: DEFAULT_REFERENCE_SCORER }]);
  });

  it("preserves context and retrieval_context (RAG grounding) into vars", () => {
    const r = convertDeepEvalDataset([
      {
        input: "Who wrote Hamlet?",
        expected_output: "Shakespeare",
        context: ["Hamlet is a tragedy by William Shakespeare."],
        retrieval_context: ["Shakespeare wrote Hamlet around 1600."],
      },
    ]);
    expect(r.config.cases[0].vars).toEqual({
      input: "Who wrote Hamlet?",
      context: ["Hamlet is a tragedy by William Shakespeare."],
      retrieval_context: ["Shakespeare wrote Hamlet around 1600."],
    });
    expect(r.withContextCount).toBe(1);
  });

  it("accepts a bare array of goldens (what save_as('json') writes)", () => {
    const r = convertDeepEvalDataset([{ input: "a", expected_output: "b" }]);
    expect(r.config.name).toBe("Imported from DeepEval");
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "b" }]);
  });

  it("accepts the { test_cases: [...] } envelope", () => {
    const r = convertDeepEvalDataset({ test_cases: [{ input: "a", expected_output: "ref" }] });
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "ref" }]);
  });

  it("accepts a single golden object", () => {
    const r = convertDeepEvalDataset({ input: "a", expected_output: { answer: "ref" } });
    expect(r.caseCount).toBe(1);
    expect(r.config.cases[0]).toEqual({ vars: { input: "a" }, expected: "ref" });
  });

  it("passes a dict input through as vars (not wrapped)", () => {
    const r = convertDeepEvalDataset([{ input: { question: "a", lang: "en" }, expected_output: "x" }]);
    expect(r.config.cases[0].vars).toEqual({ question: "a", lang: "en" });
  });

  it("wraps a bare string input under `input`", () => {
    const r = convertDeepEvalDataset([{ input: "just a string", expected_output: "x" }]);
    expect(r.config.cases[0].vars).toEqual({ input: "just a string" });
  });

  it("tolerates the legacy `expected` reference key", () => {
    const r = convertDeepEvalDataset([{ input: "a", expected: "legacy-a" }]);
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "legacy-a" }]);
  });

  it("strips secrets from input, context, AND expected_output (0 leakage in written config)", () => {
    const source = {
      goldens: [
        {
          input: { question: "hi", openai_api_key: "sk-INPUTLEAK", nested: { token: "tok-LEAK" } },
          context: [{ chunk: "grounding", api_key: "sk-CTXLEAK" }],
          expected_output: { answer: "Paris", api_key: "sk-OUTPUTLEAK" },
        },
      ],
    };
    const r = convertDeepEvalDataset(source);
    const serialized = JSON.stringify(r.config);
    expect(serialized).not.toContain("sk-INPUTLEAK");
    expect(serialized).not.toContain("sk-CTXLEAK");
    expect(serialized).not.toContain("sk-OUTPUTLEAK");
    expect(serialized).not.toContain("tok-LEAK");
    expect(r.config.cases[0].vars).toEqual({
      question: "hi",
      nested: {},
      context: [{ chunk: "grounding" }],
    });
    // expected_output had 2 keys (answer + stripped api_key). After stripping
    // the secret, the remaining single key's value becomes the reference.
    expect(r.config.cases[0].expected).toBe("Paris");
    expect(r.strippedSecretKeys).toEqual(["api_key", "openai_api_key", "token"]);
  });

  it("has NO default scorer and flags it when no golden carries a reference value", () => {
    const r = convertDeepEvalDataset({ goldens: [{ input: "a" }, { input: "b" }] });
    expect(r.withReferenceCount).toBe(0);
    expect(r.defaultScorerInjected).toBe(false);
    expect(r.config.defaultScorers).toBeUndefined();
  });

  it("handles malformed input gracefully (null / non-object records)", () => {
    expect(convertDeepEvalDataset(null).config.cases).toEqual([]);
    expect(convertDeepEvalDataset(undefined).config.cases).toEqual([]);
    expect(convertDeepEvalDataset(42).config.cases).toEqual([]);
    // Non-object records among valid ones are skipped, not written as bogus cases.
    const r = convertDeepEvalDataset({ goldens: ["nope", null, { input: "a", expected_output: "ref" }] });
    expect(r.recordCount).toBe(3);
    expect(r.caseCount).toBe(1);
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "ref" }]);
  });

  it("produces a JSON-serializable config identical for dry-run and write (no drift)", () => {
    const source = { goldens: [{ input: "a", expected_output: { answer: "ref" } }] };
    const cfg = convertDeepEvalDataset(source).config;
    const roundTripped = JSON.parse(JSON.stringify(cfg));
    expect(roundTripped).toEqual(cfg);
  });
});

describe("loadDeepEvalFile", () => {
  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-loadde-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a JSON dataset (JSON is tried first)", async () => {
    const p = writeTmp("ds.json", JSON.stringify({ alias: "DS", goldens: [] }));
    const src = (await loadDeepEvalFile(p)) as { alias: string };
    expect(src.alias).toBe("DS");
  });

  it("parses a bare-array JSON export", async () => {
    const p = writeTmp("ds.json", JSON.stringify([{ input: "a" }]));
    const src = await loadDeepEvalFile(p);
    expect(Array.isArray(src)).toBe(true);
  });

  it("parses a YAML export", async () => {
    const p = writeTmp("ds.yaml", "alias: DS\ngoldens: []\n");
    const src = (await loadDeepEvalFile(p)) as { alias: string };
    expect(src.alias).toBe("DS");
  });

  it("surfaces the REAL parser error on malformed YAML, not a generic message", async () => {
    const p = writeTmp("bad.yaml", "alias:\n  - a\n bad: [oops\nx: : :\n");
    await expect(loadDeepEvalFile(p)).rejects.toThrow(/Invalid DeepEval export/);
    await expect(loadDeepEvalFile(p)).rejects.not.toThrow(/'yaml' package is unavailable/);
  });
});
