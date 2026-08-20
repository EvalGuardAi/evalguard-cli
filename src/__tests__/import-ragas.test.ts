// Coverage for import:ragas. Bug classes:
//   - version schema variants (old question/contexts/ground_truth vs new
//     user_input/retrieved_contexts/reference) NOT resolved to the same cases
//   - input → vars mapping wrong → cases lose their variables
//   - retrieved_contexts / reference_contexts (RAG grounding) dropped
//   - single-key vs multi-key reference → `expected` gets wrong value
//   - api_key / token bleeds from a sample into a checked-in config
//   - malformed export (null / non-array / non-object records) → crash
//   - no reference values → no scorer → config can't validate (must warn)
//   - dry-run vs written config drift
//   - envelope variants (bare array / {samples} / {data} / single)

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_PROMPT,
  DEFAULT_REFERENCE_SCORER,
  convertRagasDataset,
  isSecretKey,
  loadRagasFile,
  mapReferenceOutput,
  stripSecrets,
} from "../commands/import-ragas";

describe("isSecretKey", () => {
  it("flags secret-ish keys (exact + patterned, incl. Ragas/HF keys)", () => {
    for (const k of [
      "api_key",
      "apiKey",
      "openai_api_key",
      "anthropic_api_key",
      "ragas_app_token",
      "hf_token",
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
    for (const k of ["total_tokens", "prompt_tokens", "completion_tokens", "token_count", "user_input", "retrieved_contexts", "reference"]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe("stripSecrets", () => {
  it("recursively removes secret keys and records them", () => {
    const removed = new Set<string>();
    const cleaned = stripSecrets(
      {
        user_input: "hi",
        api_key: "sk-LEAK1",
        nested: { openai_api_key: "sk-LEAK2", temperature: 0.7, deeper: [{ token: "LEAK3", ok: 1 }] },
        prompt_tokens: 5,
      },
      removed,
    );
    expect(cleaned).toEqual({
      user_input: "hi",
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

  it("takes the primary value from a single-key reference object", () => {
    expect(mapReferenceOutput({ answer: "Paris" })).toBe("Paris");
  });

  it("preserves the whole object when reference has multiple keys", () => {
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

describe("convertRagasDataset — both schema variants map identically", () => {
  const newSample = {
    user_input: "Capital of France?",
    retrieved_contexts: ["Paris is the capital of France."],
    reference_contexts: ["France is in Western Europe."],
    response: "Paris",
    reference: "Paris",
  };
  const oldSample = {
    question: "Capital of France?",
    contexts: ["Paris is the capital of France."],
    reference_contexts: ["France is in Western Europe."],
    answer: "Paris",
    ground_truth: "Paris",
  };

  it("new-schema sample → vars + expected + preserved contexts", () => {
    const r = convertRagasDataset([newSample]);
    expect(r.config.cases[0]).toEqual({
      vars: {
        input: "Capital of France?",
        retrieved_contexts: ["Paris is the capital of France."],
        reference_contexts: ["France is in Western Europe."],
      },
      expected: "Paris",
    });
    expect(r.withReferenceCount).toBe(1);
    expect(r.withContextCount).toBe(1);
  });

  it("old-schema sample produces the SAME case as the new-schema sample", () => {
    const oldCase = convertRagasDataset([oldSample]).config.cases[0];
    const newCase = convertRagasDataset([newSample]).config.cases[0];
    expect(oldCase).toEqual(newCase);
  });

  it("resolves ground_truths (string[]) as the reference", () => {
    const r = convertRagasDataset([{ user_input: "q", ground_truths: ["ref-a", "ref-b"] }]);
    expect(r.config.cases[0].expected).toBe(JSON.stringify(["ref-a", "ref-b"]));
  });
});

describe("convertRagasDataset — full conversion", () => {
  it("emits a scaffold {{input}} prompt and injects a default scorer when references exist", () => {
    const r = convertRagasDataset({
      name: "RAG regression",
      description: "Golden answers for the support bot",
      samples: [
        { user_input: "Capital of France?", reference: "Paris" },
        { user_input: "2+2?", reference: "4" },
      ],
    });
    expect(r.config.name).toBe("RAG regression");
    expect(r.config.description).toBe("Golden answers for the support bot");
    expect(r.config.prompt).toBe(DEFAULT_PROMPT);
    expect(r.config.cases).toEqual([
      { vars: { input: "Capital of France?" }, expected: "Paris" },
      { vars: { input: "2+2?" }, expected: "4" },
    ]);
    expect(r.withReferenceCount).toBe(2);
    expect(r.defaultScorerInjected).toBe(true);
    expect(r.config.defaultScorers).toEqual([{ scorer: DEFAULT_REFERENCE_SCORER }]);
  });

  it("accepts a bare array of samples", () => {
    const r = convertRagasDataset([{ user_input: "a", reference: "b" }]);
    expect(r.config.name).toBe("Imported from Ragas");
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "b" }]);
  });

  it("accepts the { data: [...] } envelope", () => {
    const r = convertRagasDataset({ data: [{ user_input: "a", reference: "ref" }] });
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "ref" }]);
  });

  it("accepts a single sample object", () => {
    const r = convertRagasDataset({ user_input: "a", reference: { answer: "ref" } });
    expect(r.caseCount).toBe(1);
    expect(r.config.cases[0]).toEqual({ vars: { input: "a" }, expected: "ref" });
  });

  it("passes a dict input through as vars (not wrapped)", () => {
    const r = convertRagasDataset([{ user_input: { question: "a", lang: "en" }, reference: "x" }]);
    expect(r.config.cases[0].vars).toEqual({ question: "a", lang: "en" });
  });

  it("wraps a bare string input under `input`", () => {
    const r = convertRagasDataset([{ user_input: "just a string", reference: "x" }]);
    expect(r.config.cases[0].vars).toEqual({ input: "just a string" });
  });

  it("strips secrets from input, contexts, AND reference (0 leakage in written config)", () => {
    const source = {
      samples: [
        {
          user_input: { question: "hi", openai_api_key: "sk-INPUTLEAK", nested: { token: "tok-LEAK" } },
          retrieved_contexts: [{ chunk: "grounding", api_key: "sk-CTXLEAK" }],
          reference: { answer: "Paris", api_key: "sk-OUTPUTLEAK" },
        },
      ],
    };
    const r = convertRagasDataset(source);
    const serialized = JSON.stringify(r.config);
    expect(serialized).not.toContain("sk-INPUTLEAK");
    expect(serialized).not.toContain("sk-CTXLEAK");
    expect(serialized).not.toContain("sk-OUTPUTLEAK");
    expect(serialized).not.toContain("tok-LEAK");
    expect(r.config.cases[0].vars).toEqual({
      question: "hi",
      nested: {},
      retrieved_contexts: [{ chunk: "grounding" }],
    });
    // reference had 2 keys (answer + stripped api_key). After stripping the
    // secret, the remaining single key's value becomes the reference.
    expect(r.config.cases[0].expected).toBe("Paris");
    expect(r.strippedSecretKeys).toEqual(["api_key", "openai_api_key", "token"]);
  });

  it("has NO default scorer and flags it when no sample carries a reference value", () => {
    const r = convertRagasDataset({ samples: [{ user_input: "a" }, { user_input: "b" }] });
    expect(r.withReferenceCount).toBe(0);
    expect(r.defaultScorerInjected).toBe(false);
    expect(r.config.defaultScorers).toBeUndefined();
  });

  it("handles malformed input gracefully (null / non-object records)", () => {
    expect(convertRagasDataset(null).config.cases).toEqual([]);
    expect(convertRagasDataset(undefined).config.cases).toEqual([]);
    expect(convertRagasDataset(42).config.cases).toEqual([]);
    // Non-object records among valid ones are skipped, not written as bogus cases.
    const r = convertRagasDataset({ samples: ["nope", null, { user_input: "a", reference: "ref" }] });
    expect(r.recordCount).toBe(3);
    expect(r.caseCount).toBe(1);
    expect(r.config.cases).toEqual([{ vars: { input: "a" }, expected: "ref" }]);
  });

  it("produces a JSON-serializable config identical for dry-run and write (no drift)", () => {
    const source = { samples: [{ user_input: "a", reference: { answer: "ref" } }] };
    const cfg = convertRagasDataset(source).config;
    const roundTripped = JSON.parse(JSON.stringify(cfg));
    expect(roundTripped).toEqual(cfg);
  });
});

describe("loadRagasFile", () => {
  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-loadragas-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a JSON dataset (JSON is tried first)", async () => {
    const p = writeTmp("ds.json", JSON.stringify({ name: "DS", samples: [] }));
    const src = (await loadRagasFile(p)) as { name: string };
    expect(src.name).toBe("DS");
  });

  it("parses a bare-array JSON export", async () => {
    const p = writeTmp("ds.json", JSON.stringify([{ user_input: "a" }]));
    const src = await loadRagasFile(p);
    expect(Array.isArray(src)).toBe(true);
  });

  it("parses a YAML export", async () => {
    const p = writeTmp("ds.yaml", "name: DS\nsamples: []\n");
    const src = (await loadRagasFile(p)) as { name: string };
    expect(src.name).toBe("DS");
  });

  it("surfaces the REAL parser error on malformed YAML, not a generic message", async () => {
    const p = writeTmp("bad.yaml", "name:\n  - a\n bad: [oops\nx: : :\n");
    await expect(loadRagasFile(p)).rejects.toThrow(/Invalid Ragas export/);
    await expect(loadRagasFile(p)).rejects.not.toThrow(/'yaml' package is unavailable/);
  });
});
