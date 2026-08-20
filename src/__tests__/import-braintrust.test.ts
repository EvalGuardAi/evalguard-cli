// Coverage for import:braintrust. Bug classes:
//   - input → vars mapping wrong → cases lose their variables
//   - single-key vs multi-key expected → `expected` gets the wrong reference
//   - api_key / token bleeds from a record into a checked-in config
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
  convertBraintrustDataset,
  isSecretKey,
  loadBraintrustFile,
  mapReferenceOutput,
  stripSecrets,
} from "../commands/import-braintrust";

describe("isSecretKey", () => {
  it("flags secret-ish keys (exact + patterned)", () => {
    for (const k of [
      "api_key",
      "apiKey",
      "openai_api_key",
      "anthropic_api_key",
      "braintrust_api_key",
      "bt_api_key",
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
  it("passes a bare string / number / boolean through", () => {
    expect(mapReferenceOutput("Paris")).toBe("Paris");
    expect(mapReferenceOutput(7)).toBe("7");
    expect(mapReferenceOutput(true)).toBe("true");
  });

  it("takes the primary value from a single-key expected object", () => {
    expect(mapReferenceOutput({ answer: "Paris" })).toBe("Paris");
    expect(mapReferenceOutput({ output: "42" })).toBe("42");
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

describe("convertBraintrustDataset — full conversion", () => {
  it("maps records → cases with vars=input and expected=reference value", () => {
    const source = {
      name: "QA regression",
      description: "Golden answers for the support bot",
      events: [
        { id: "r-1", input: { question: "Capital of France?" }, expected: "Paris" },
        { id: "r-2", input: { question: "2+2?" }, expected: "4" },
      ],
    };
    const r = convertBraintrustDataset(source);
    expect(r.config.name).toBe("QA regression");
    expect(r.config.description).toBe("Golden answers for the support bot");
    expect(r.config.cases).toEqual([
      { vars: { question: "Capital of France?" }, expected: "Paris" },
      { vars: { question: "2+2?" }, expected: "4" },
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

  it("accepts a bare array of records", () => {
    const r = convertBraintrustDataset([{ input: { q: "a" }, expected: "b" }]);
    expect(r.config.name).toBe("Imported from Braintrust");
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "b" }]);
  });

  it("accepts the { records: [...] } envelope", () => {
    const r = convertBraintrustDataset({ records: [{ input: { q: "a" }, expected: "ref" }] });
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "ref" }]);
  });

  it("accepts the { data: [...] } envelope", () => {
    const r = convertBraintrustDataset({ data: [{ input: { q: "a" }, expected: "ref" }] });
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "ref" }]);
  });

  it("accepts a single record object", () => {
    const r = convertBraintrustDataset({ input: { q: "a" }, expected: { answer: "ref" } });
    expect(r.caseCount).toBe(1);
    expect(r.config.cases[0]).toEqual({ vars: { q: "a" }, expected: "ref" });
  });

  it("wraps a non-object input value under `input`", () => {
    const r = convertBraintrustDataset([{ input: "just a string", expected: "x" }]);
    expect(r.config.cases[0].vars).toEqual({ input: "just a string" });
  });

  it("tolerates the legacy `expected_output` / `output` reference keys", () => {
    const r = convertBraintrustDataset([
      { input: { q: "a" }, expected_output: "legacy-a" },
      { input: { q: "b" }, output: "legacy-b" },
    ]);
    expect(r.config.cases).toEqual([
      { vars: { q: "a" }, expected: "legacy-a" },
      { vars: { q: "b" }, expected: "legacy-b" },
    ]);
  });

  it("strips secrets from BOTH input and expected (0 leakage in written config)", () => {
    const source = {
      events: [
        {
          input: { question: "hi", openai_api_key: "sk-INPUTLEAK", nested: { token: "tok-LEAK" } },
          expected: { answer: "Paris", api_key: "sk-OUTPUTLEAK" },
        },
      ],
    };
    const r = convertBraintrustDataset(source);
    const serialized = JSON.stringify(r.config);
    expect(serialized).not.toContain("sk-INPUTLEAK");
    expect(serialized).not.toContain("sk-OUTPUTLEAK");
    expect(serialized).not.toContain("tok-LEAK");
    expect(r.config.cases[0].vars).toEqual({ question: "hi", nested: {} });
    // expected had 2 keys (answer + stripped api_key). After stripping the
    // secret, the remaining single key's value becomes the reference.
    expect(r.config.cases[0].expected).toBe("Paris");
    expect(r.strippedSecretKeys).toEqual(["api_key", "openai_api_key", "token"]);
  });

  it("has NO default scorer and flags it when no record carries a reference value", () => {
    const r = convertBraintrustDataset({ events: [{ input: { q: "a" } }, { input: { q: "b" } }] });
    expect(r.withReferenceCount).toBe(0);
    expect(r.defaultScorerInjected).toBe(false);
    expect(r.config.defaultScorers).toBeUndefined();
  });

  it("handles malformed input gracefully (null / non-object records)", () => {
    expect(convertBraintrustDataset(null).config.cases).toEqual([]);
    expect(convertBraintrustDataset(undefined).config.cases).toEqual([]);
    expect(convertBraintrustDataset(42).config.cases).toEqual([]);
    // Non-object records among valid ones are skipped, not written as bogus cases.
    const r = convertBraintrustDataset({ events: ["nope", null, { input: { q: "a" }, expected: "ref" }] });
    expect(r.recordCount).toBe(3);
    expect(r.caseCount).toBe(1);
    expect(r.config.cases).toEqual([{ vars: { q: "a" }, expected: "ref" }]);
  });

  it("produces a JSON-serializable config identical for dry-run and write (no drift)", () => {
    const source = { events: [{ input: { q: "a" }, expected: { answer: "ref" } }] };
    const cfg = convertBraintrustDataset(source).config;
    const roundTripped = JSON.parse(JSON.stringify(cfg));
    expect(roundTripped).toEqual(cfg);
  });
});

describe("loadBraintrustFile", () => {
  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-loadbt-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a JSON dataset (JSON is tried first)", async () => {
    const p = writeTmp("ds.json", JSON.stringify({ name: "DS", events: [] }));
    const src = (await loadBraintrustFile(p)) as { name: string };
    expect(src.name).toBe("DS");
  });

  it("parses a bare-array JSON export", async () => {
    const p = writeTmp("ds.json", JSON.stringify([{ input: { q: "a" } }]));
    const src = await loadBraintrustFile(p);
    expect(Array.isArray(src)).toBe(true);
  });

  it("parses a YAML export", async () => {
    const p = writeTmp("ds.yaml", "name: DS\nevents: []\n");
    const src = (await loadBraintrustFile(p)) as { name: string };
    expect(src.name).toBe("DS");
  });

  it("surfaces the REAL parser error on a malformed YAML, not a generic message", async () => {
    const p = writeTmp("bad.yaml", "name:\n  - a\n bad: [oops\nx: : :\n");
    await expect(loadBraintrustFile(p)).rejects.toThrow(/Invalid Braintrust export/);
    await expect(loadBraintrustFile(p)).rejects.not.toThrow(/'yaml' package is unavailable/);
  });
});
