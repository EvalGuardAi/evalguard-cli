// Unit tests for `evalguard import:openai-evals` — the openai/evals dataset
// converter. Mirrors import-deepeval.test.ts. Pure convert/parse functions.
import { describe, expect, it } from "vitest";
import {
  isSecretKey,
  stripSecrets,
  convertOpenAIEvals,
  parseOpenAIEvalsFile,
} from "../commands/import-openai-evals.js";

describe("import:openai-evals — isSecretKey/stripSecrets", () => {
  it("strips a secret embedded in a system prompt / metadata", () => {
    const removed = new Set<string>();
    const cleaned = stripSecrets(
      { input: [{ role: "system", content: "sys" }], api_key: "sk-xxx", ideal: "4" },
      removed,
    );
    expect(cleaned).toEqual({ input: [{ role: "system", content: "sys" }], ideal: "4" });
    expect([...removed]).toEqual(["api_key"]);
  });
  it("does NOT flag total_tokens / token_count", () => {
    expect(isSecretKey("total_tokens")).toBe(false);
    expect(isSecretKey("openai_api_key")).toBe(true);
  });
});

describe("import:openai-evals — convertOpenAIEvals", () => {
  it("messages-array input → last user turn as vars.input, system as vars.system", () => {
    const r = convertOpenAIEvals([
      {
        input: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "2+2?" },
        ],
        ideal: "4",
      },
    ]);
    expect(r.caseCount).toBe(1);
    expect(r.config.cases[0].vars).toEqual({ input: "2+2?", system: "You are terse." });
    expect(r.config.cases[0].expected).toBe("4");
    expect(r.withReferenceCount).toBe(1);
    // string ideal → default equals scorer injected
    expect(r.config.defaultScorers).toEqual([{ scorer: "equals" }]);
    expect(r.defaultScorerInjected).toBe(true);
  });

  it("bare-string input → vars.input", () => {
    const r = convertOpenAIEvals([{ input: "Capital of France?", ideal: "Paris" }]);
    expect(r.config.cases[0].vars).toEqual({ input: "Capital of France?" });
    expect(r.config.cases[0].expected).toBe("Paris");
  });

  it("array ideal (accept any) → per-case contains-any scorer + primary expected", () => {
    const r = convertOpenAIEvals([{ input: "Capital of France?", ideal: ["Paris", "paris"] }]);
    expect(r.withMultiIdealCount).toBe(1);
    expect(r.config.cases[0].scorers).toEqual([{ scorer: "contains-any", value: ["Paris", "paris"] }]);
    expect(r.config.cases[0].expected).toBe("Paris");
    // no string-ideal case → no default equals scorer
    expect(r.config.defaultScorers).toBeUndefined();
  });

  it("sample with no ideal → case with just vars, no expected", () => {
    const r = convertOpenAIEvals([{ input: "open-ended prompt" }]);
    expect(r.config.cases[0]).toEqual({ vars: { input: "open-ended prompt" } });
    expect(r.withReferenceCount).toBe(0);
  });

  it("tolerates {samples:[...]} + {data:[...]} envelopes and a name field", () => {
    const r = convertOpenAIEvals({ name: "my-eval", samples: [{ input: "x", ideal: "y" }] });
    expect(r.config.name).toBe("my-eval");
    expect(r.caseCount).toBe(1);
    const r2 = convertOpenAIEvals({ data: [{ input: "x", ideal: "y" }] });
    expect(r2.caseCount).toBe(1);
  });

  it("default name + scaffold prompt when metadata absent", () => {
    const r = convertOpenAIEvals([{ input: "x", ideal: "y" }]);
    expect(r.config.name).toBe("Imported from OpenAI Evals");
    expect(r.config.prompt).toBe("{{input}}");
  });

  it("strips a provider key hidden in a sample and reports it", () => {
    const r = convertOpenAIEvals([{ input: "x", ideal: "y", openai_api_key: "sk-leak" }]);
    expect(r.strippedSecretKeys).toContain("openai_api_key");
    expect(JSON.stringify(r.config)).not.toContain("sk-leak");
  });

  it("skips non-object samples without crashing", () => {
    const r = convertOpenAIEvals(["not-an-object", 42, null, { input: "x", ideal: "y" }]);
    expect(r.recordCount).toBe(4);
    expect(r.caseCount).toBe(1);
  });
});

describe("import:openai-evals — parseOpenAIEvalsFile", () => {
  it("parses JSONL (one sample per line)", () => {
    const raw = '{"input":"a","ideal":"1"}\n{"input":"b","ideal":"2"}\n';
    const parsed = parseOpenAIEvalsFile(raw) as unknown[];
    expect(parsed).toHaveLength(2);
  });
  it("parses a JSON array", () => {
    const parsed = parseOpenAIEvalsFile('[{"input":"a","ideal":"1"}]') as unknown[];
    expect(parsed).toHaveLength(1);
  });
  it("empty file → empty list", () => {
    expect(parseOpenAIEvalsFile("   ")).toEqual([]);
  });
});
