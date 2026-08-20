// Coverage for import:humanloop. Bugs class:
//   - Multi-project export silently picks wrong one → user surprised
//   - api_key fields bleed into checked-in evalguard.config.json
//   - Empty datasets → crash on .map of undefined
//   - Unknown evaluator type → unmapped report misses it
//   - Provider dedup wrong → 10 providers for 1 actual model

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  EVALUATOR_TYPE_MAP,
  convertHumanloopExport,
  loadHumanloopFile,
  mapHumanloopEvaluator,
  mapHumanloopModelConfig,
} from "../commands/import-humanloop";

describe("mapHumanloopModelConfig", () => {
  it("extracts provider + model + non-secret config", () => {
    expect(
      mapHumanloopModelConfig({
        provider: "openai",
        model: "gpt-4o",
        temperature: 0.7,
        max_tokens: 500,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-4o",
      config: { temperature: 0.7, max_tokens: 500 },
    });
  });

  it("strips every secret key shape (api_key, apiKey, openai_api_key, secret, token)", () => {
    const result = mapHumanloopModelConfig({
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.5,
      api_key: "sk-LEAK1",
      apiKey: "sk-LEAK2",
      openai_api_key: "sk-LEAK3",
      anthropic_api_key: "sk-ant-LEAK4",
      azure_api_key: "az-LEAK5",
      secret: "LEAK6",
      token: "LEAK7",
    });
    expect(result.config).toEqual({ temperature: 0.5 });
    for (const key of [
      "api_key",
      "apiKey",
      "openai_api_key",
      "anthropic_api_key",
      "azure_api_key",
      "secret",
      "token",
    ]) {
      expect(result.config).not.toHaveProperty(key);
    }
  });

  it("omits config when only provider/model were set", () => {
    expect(mapHumanloopModelConfig({ provider: "openai", model: "gpt-4o" })).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("defaults to openai gpt-4o when fields missing", () => {
    expect(mapHumanloopModelConfig({})).toEqual({ provider: "openai", model: "gpt-4o" });
  });
});

describe("mapHumanloopEvaluator", () => {
  it("maps 'human' → 'human-annotation'", () => {
    expect(mapHumanloopEvaluator({ type: "human" })).toEqual({ scorer: "human-annotation" });
  });

  it("maps 'llm' → 'llm-grader' (and llm-rubric alias)", () => {
    expect(mapHumanloopEvaluator({ type: "llm" })).toEqual({ scorer: "llm-grader" });
    expect(mapHumanloopEvaluator({ type: "llm-rubric" })).toEqual({ scorer: "llm-grader" });
  });

  it("maps built-in evaluator names by `name` field too", () => {
    expect(mapHumanloopEvaluator({ name: "toxicity" })).toEqual({ scorer: "toxicity" });
  });

  it("preserves threshold + value", () => {
    expect(
      mapHumanloopEvaluator({ type: "factuality", threshold: 0.8, value: "Paris" }),
    ).toEqual({ scorer: "factuality", threshold: 0.8, value: "Paris" });
  });

  it("returns null on malformed evaluator (no type/name/metric)", () => {
    expect(mapHumanloopEvaluator({ value: "foo" })).toBeNull();
  });

  it("passes unknown evaluator types through verbatim", () => {
    expect(mapHumanloopEvaluator({ type: "code" })).toEqual({ scorer: "code", value: undefined });
  });

  it("is case-insensitive on the key", () => {
    expect(mapHumanloopEvaluator({ type: "TOXICITY" })).toEqual({ scorer: "toxicity" });
  });
});

describe("convertHumanloopExport — full conversion", () => {
  it("converts a minimal single-project export", () => {
    const source = {
      name: "Customer support bot",
      prompts: [
        {
          name: "greeting",
          template: "Hello {{name}}, how can I help?",
          model_config: { provider: "openai", model: "gpt-4o", temperature: 0.7 },
        },
      ],
      datasets: [{ name: "queries", inputs: [{ name: "Alice" }, { name: "Bob" }] }],
      evaluators: [{ type: "human" }, { type: "toxicity" }],
    };
    const result = convertHumanloopExport(source);
    expect(result.config.name).toBe("Customer support bot");
    expect(result.config.providers).toEqual([
      { provider: "openai", model: "gpt-4o", config: { temperature: 0.7 } },
    ]);
    expect(result.config.prompts).toEqual(["Hello {{name}}, how can I help?"]);
    expect(result.caseCount).toBe(2);
    expect(result.evaluatorCount).toBe(2);
    expect(result.unmappedEvaluators).toEqual([]);
  });

  it("dedupes providers across prompts using the same model_config", () => {
    const source = {
      prompts: [
        { template: "a", model_config: { provider: "openai", model: "gpt-4o" } },
        { template: "b", model_config: { provider: "openai", model: "gpt-4o" } },
        { template: "c", model_config: { provider: "openai", model: "gpt-4o-mini" } },
      ],
    };
    const result = convertHumanloopExport(source);
    expect(result.config.providers).toHaveLength(2);
    expect(result.config.providers.map((p) => p.model)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("multi-project export — picks first when --project not specified", () => {
    const source = {
      projects: [
        { name: "Project A", prompts: [{ template: "from A" }] },
        { name: "Project B", prompts: [{ template: "from B" }] },
      ],
    };
    const result = convertHumanloopExport(source);
    expect(result.config.name).toBe("Project A");
    expect(result.config.prompts).toEqual(["from A"]);
    expect(result.projectsFound).toEqual(["Project A", "Project B"]);
  });

  it("multi-project export — picks named project when selectProject set", () => {
    const source = {
      projects: [
        { name: "Project A", prompts: [{ template: "from A" }] },
        { name: "Project B", prompts: [{ template: "from B" }] },
      ],
    };
    const result = convertHumanloopExport(source, { selectProject: "Project B" });
    expect(result.config.name).toBe("Project B");
    expect(result.config.prompts).toEqual(["from B"]);
  });

  it("multi-project export — throws when selectProject doesn't match", () => {
    const source = {
      projects: [{ name: "Project A", prompts: [] }],
    };
    expect(() =>
      convertHumanloopExport(source, { selectProject: "Project Z" }),
    ).toThrow(/Project 'Project Z' not found/);
  });

  it("handles empty / missing fields without crashing", () => {
    const result = convertHumanloopExport({});
    expect(result.config.providers).toEqual([]);
    expect(result.config.prompts).toEqual([]);
    expect(result.caseCount).toBe(0);
    expect(result.evaluatorCount).toBe(0);
    expect(result.unmappedEvaluators).toEqual([]);
  });

  it("dedupes unmapped evaluator types in the report", () => {
    const source = {
      evaluators: [{ type: "code" }, { type: "custom" }, { type: "code" }],
    };
    const result = convertHumanloopExport(source);
    // 'code' and 'custom' are not in EVALUATOR_TYPE_MAP — pass through.
    expect(result.unmappedEvaluators).toEqual(["code", "custom"]);
  });

  it("counts + writes ONLY truly-mapped evaluators (no bogus scorer names, no over-count)", () => {
    const source = {
      evaluators: [
        { type: "toxicity", threshold: 0.1 },
        { type: "code" }, // unknown → must NOT be written or counted
        { type: "custom" }, // unknown → must NOT be written or counted
      ],
    };
    const result = convertHumanloopExport(source);
    // Only `toxicity` maps → count 1, and it's the only written scorer.
    expect(result.evaluatorCount).toBe(1);
    expect(result.config.defaultScorers).toEqual([{ scorer: "toxicity", threshold: 0.1 }]);
    // The unknown passthroughs are reported, not silently written as scorers.
    expect(result.unmappedEvaluators).toEqual(["code", "custom"]);
    const scorerNames = (result.config.defaultScorers ?? []).map((s) => s.scorer);
    expect(scorerNames).not.toContain("code");
    expect(scorerNames).not.toContain("custom");
  });

  it("flattens dataset inputs into cases with description tag", () => {
    const source = {
      datasets: [
        { name: "queries-v1", inputs: [{ q: "Hello" }, { q: "Goodbye" }] },
      ],
    };
    const result = convertHumanloopExport(source);
    expect(result.config.cases).toEqual([
      { vars: { q: "Hello" }, description: "from dataset: queries-v1" },
      { vars: { q: "Goodbye" }, description: "from dataset: queries-v1" },
    ]);
  });

  it("supports both modelConfig (camelCase) and model_config (snake_case) — Humanloop has shipped both", () => {
    const source = {
      prompts: [
        { template: "a", model_config: { provider: "openai", model: "gpt-4o" } },
        { template: "b", modelConfig: { provider: "anthropic", model: "claude-3-5-sonnet" } },
      ],
    };
    const result = convertHumanloopExport(source);
    expect(result.config.providers).toHaveLength(2);
    expect(result.config.providers.map((p) => p.provider)).toEqual(["openai", "anthropic"]);
  });
});

describe("EVALUATOR_TYPE_MAP — coverage floor", () => {
  it("covers the 9 humanloop evaluator surface we promise to migrate", () => {
    for (const t of [
      "human", "llm", "llm-rubric", "model-graded",
      "exact_match", "contains", "toxicity", "bias", "factuality", "relevance",
    ]) {
      expect(EVALUATOR_TYPE_MAP[t]).toBeDefined();
    }
  });
});

describe("loadHumanloopFile — surfaces the real parse error, not a generic 'could not parse'", () => {
  // Regression (live E2E 2026-07-16): a malformed export was reported with a
  // generic "could not parse" that swallowed the real error. With `yaml`
  // installed, loadHumanloopFile must surface the actual parser error.
  function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-loadhl-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a JSON export (JSON is tried first)", async () => {
    const p = writeTmp("export.json", JSON.stringify({ name: "Bot" }));
    const cfg = await loadHumanloopFile(p);
    expect(cfg.name).toBe("Bot");
  });

  it("parses a YAML export", async () => {
    const p = writeTmp("export.yaml", "name: Bot\nprompts: []\n");
    const cfg = await loadHumanloopFile(p);
    expect(cfg.name).toBe("Bot");
  });

  it("throws the REAL parser error (with detail), NOT a bare 'could not parse'", async () => {
    const p = writeTmp("bad.yaml", "name:\n  - a\n bad: [oops\nx: : :\n");
    await expect(loadHumanloopFile(p)).rejects.toThrow(/Invalid Humanloop export/);
    await expect(loadHumanloopFile(p)).rejects.not.toThrow(/'yaml' package is unavailable/);
  });
});
