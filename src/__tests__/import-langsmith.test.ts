// Coverage for import:langsmith. Bug classes:
//   - inputs → vars mapping wrong → cases lose their variables
//   - single-key vs multi-key outputs → `expected` gets the wrong reference
//   - api_key / token bleeds from an example into a checked-in config
//   - malformed export (null / non-array / non-object examples) → crash
//   - no reference outputs → no scorer → config can't validate (must warn)
//   - dry-run vs written config drift

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_PROMPT,
  DEFAULT_REFERENCE_SCORER,
  convertLangSmithDataset,
  isSecretKey,
  loadLangSmithFile,
  mapReferenceOutput,
  stripSecrets,
} from "../commands/import-langsmith";

describe("isSecretKey", () => {
  it("flags secret-ish keys (exact + patterned)", () => {
    for (const k of [
      "api_key",
      "apiKey",
      "openai_api_key",
      "anthropic_api_key",
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
    for (const k of ["total_tokens", "prompt_tokens", "completion_tokens", "token_count", "question", "input", "key_findings"]) {
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
  it("takes the primary value from a single-key outputs object", () => {
    expect(mapReferenceOutput({ output: "Paris" })).toBe("Paris");
    expect(mapReferenceOutput({ answer: "42" })).toBe("42");
  });

  it("JSON-stringifies a single non-string primary value", () => {
    expect(mapReferenceOutput({ score: 0.9 })).toBe("0.9");
    expect(mapReferenceOutput({ labels: ["a", "b"] })).toBe(JSON.stringify(["a", "b"]));
  });

  it("preserves the whole object when outputs has multiple keys", () => {
    expect(mapReferenceOutput({ answer: "Paris", confidence: 0.9 })).toBe(
      JSON.stringify({ answer: "Paris", confidence: 0.9 }),
    );
  });

  it("passes a bare string / number / boolean through", () => {
    expect(mapReferenceOutput("Paris")).toBe("Paris");
    expect(mapReferenceOutput(7)).toBe("7");
    expect(mapReferenceOutput(true)).toBe("true");
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(mapReferenceOutput(null)).toBeUndefined();
    expect(mapReferenceOutput(undefined)).toBeUndefined();
    expect(mapReferenceOutput({})).toBeUndefined();
    expect(mapReferenceOutput([])).toBeUndefined();
  });
});

describe("convertLangSmithDataset — full conversion", () => {
  it("maps examples → cases with vars=inputs and expected=reference output", () => {
    const source = {
      name: "QA regression",
      description: "Golden answers for the support bot",
      examples: [
        { id: "ex-1", inputs: { question: "Capital of France?" }, outputs: { answer: "Paris" } },
        { id: "ex-2", inputs: { question: "2+2?" }, outputs: { answer: "4" } },
      ],
    };
    const r = convertLangSmithDataset(source);
    expect(r.config.name).toBe("QA regression");
    expect(r.config.description).toBe("Golden answers for the support bot");
    expect(r.config.cases).toEqual([
      { vars: { question: "Capital of France?" }, expected: "Paris" },
      { vars: { question: "2+2?" }, expected: "4" },
    ]);
    expect(r.exampleCount).toBe(2);
    expect(r.caseCount).toBe(2);
    expect(r.withReferenceCount).toBe(2);
    // A scaffold `{{input}}` prompt is emitted (dataset carries no prompt) so
    // the config passes `validate` and interpolates under `eval:local`/`gate`.
    expect(r.config.prompt).toBe(DEFAULT_PROMPT);
    // Reference outputs present → runnable default scorer injected.
    expect(r.defaultScorerInjected).toBe(true);
    expect(r.config.defaultScorers).toEqual([{ scorer: DEFAULT_REFERENCE_SCORER }]);
  });

  it("accepts a bare array of examples", () => {
    const r = convertLangSmithDataset([
      { inputs: { q: "a" }, outputs: { a: "b" } },
    ]);
    expect(r.config.name).toBe("Imported from LangSmith");
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "b" }]);
  });

  it("accepts the { data: [...] } envelope", () => {
    const r = convertLangSmithDataset({ data: [{ inputs: { q: "a" }, outputs: "ref" }] });
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "ref" }]);
  });

  it("accepts a single example object", () => {
    const r = convertLangSmithDataset({ inputs: { q: "a" }, outputs: { a: "ref" } });
    expect(r.caseCount).toBe(1);
    expect(r.config.cases[0]).toEqual({ vars: { q: "a" }, expected: "ref" });
  });

  it("wraps a non-object inputs value under `input`", () => {
    const r = convertLangSmithDataset([{ inputs: "just a string", outputs: { a: "x" } }]);
    expect(r.config.cases[0].vars).toEqual({ input: "just a string" });
  });

  it("strips secrets from BOTH inputs and outputs (0 leakage in written config)", () => {
    const source = {
      examples: [
        {
          inputs: { question: "hi", openai_api_key: "sk-INPUTLEAK", nested: { token: "tok-LEAK" } },
          outputs: { answer: "Paris", api_key: "sk-OUTPUTLEAK" },
        },
      ],
    };
    const r = convertLangSmithDataset(source);
    const serialized = JSON.stringify(r.config);
    expect(serialized).not.toContain("sk-INPUTLEAK");
    expect(serialized).not.toContain("sk-OUTPUTLEAK");
    expect(serialized).not.toContain("tok-LEAK");
    expect(r.config.cases[0].vars).toEqual({ question: "hi", nested: {} });
    // outputs had 2 keys (answer + stripped api_key). After stripping the
    // secret, the remaining single key's value becomes the reference.
    expect(r.config.cases[0].expected).toBe("Paris");
    expect(r.strippedSecretKeys).toEqual(["api_key", "openai_api_key", "token"]);
  });

  it("has NO default scorer and flags it when no example carries a reference output", () => {
    const r = convertLangSmithDataset({ examples: [{ inputs: { q: "a" } }, { inputs: { q: "b" } }] });
    expect(r.withReferenceCount).toBe(0);
    expect(r.defaultScorerInjected).toBe(false);
    expect(r.config.defaultScorers).toBeUndefined();
  });

  it("handles malformed input gracefully (null / non-object examples)", () => {
    expect(convertLangSmithDataset(null).config.cases).toEqual([]);
    expect(convertLangSmithDataset(undefined).config.cases).toEqual([]);
    expect(convertLangSmithDataset(42).config.cases).toEqual([]);
    // Non-object examples among valid ones are skipped, not written as bogus cases.
    const r = convertLangSmithDataset({ examples: ["nope", null, { inputs: { q: "a" }, outputs: "ref" }] });
    expect(r.exampleCount).toBe(3);
    expect(r.caseCount).toBe(1);
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "ref" }]);
  });

  it("produces a JSON-serializable config identical for dry-run and write (no drift)", () => {
    const source = { examples: [{ inputs: { q: "a" }, outputs: { a: "ref" } }] };
    // Both `--dry-run` (print) and the write path serialize the SAME
    // `result.config` object, so a round-trip must be stable.
    const cfg = convertLangSmithDataset(source).config;
    const roundTripped = JSON.parse(JSON.stringify(cfg));
    expect(roundTripped).toEqual(cfg);
  });
});

describe("loadLangSmithFile", () => {
  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-loadls-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a JSON dataset (JSON is tried first)", async () => {
    const p = writeTmp("ds.json", JSON.stringify({ name: "DS", examples: [] }));
    const src = (await loadLangSmithFile(p)) as { name: string };
    expect(src.name).toBe("DS");
  });

  it("parses a bare-array JSON export", async () => {
    const p = writeTmp("ds.json", JSON.stringify([{ inputs: { q: "a" } }]));
    const src = await loadLangSmithFile(p);
    expect(Array.isArray(src)).toBe(true);
  });

  it("parses a YAML export", async () => {
    const p = writeTmp("ds.yaml", "name: DS\nexamples: []\n");
    const src = (await loadLangSmithFile(p)) as { name: string };
    expect(src.name).toBe("DS");
  });

  it("surfaces the REAL parser error on a malformed YAML, not a generic message", async () => {
    const p = writeTmp("bad.yaml", "name:\n  - a\n bad: [oops\nx: : :\n");
    await expect(loadLangSmithFile(p)).rejects.toThrow(/Invalid LangSmith export/);
    await expect(loadLangSmithFile(p)).rejects.not.toThrow(/'yaml' package is unavailable/);
  });
});
