import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  BUILT_IN_SCORERS,
  ATTACK_TYPES,
  ALL_PLUGINS,
  ALL_STRATEGIES,
  ALL_GRADERS,
} from "@evalguard/core";
import { validateConfigObject, type ValidateRegistries } from "../validate.js";
import { TEMPLATES, LOCAL_YAML } from "../init.js";

/*
 * Regression for "init templates fail the tool's own `validate`" (live E2E
 * audit 2026-07-15). hello-world/agent used `type: llm-rubric` (a Promptfoo
 * alias the runtime maps to `llm-grader`, but the validator rejected as an
 * "Unknown scorer"); security-scan used the plugin `hallucination` (valid id is
 * `hallucination-probe`). `init <template>` → `validate evalguard.yaml` must
 * pass for EVERY template.
 */
const registries = {
  BUILT_IN_SCORERS,
  ATTACK_TYPES,
  ALL_PLUGINS,
  ALL_STRATEGIES,
  ALL_GRADERS,
} as unknown as ValidateRegistries;

describe("init templates pass `validate` (E2E-audit 2026-07-15)", () => {
  for (const [name, tmpl] of Object.entries(TEMPLATES)) {
    it(`template '${name}' validates with zero errors`, () => {
      const config = parseYaml(tmpl.yaml) as Record<string, unknown>;
      const { errors } = validateConfigObject(config, registries);
      expect(errors).toEqual([]);
    });
  }

  it("the --local template validates with zero errors", () => {
    const config = parseYaml(LOCAL_YAML) as Record<string, unknown>;
    const { errors } = validateConfigObject(config, registries);
    expect(errors).toEqual([]);
  });

  it("accepts the `llm-rubric` alias the runtime maps to `llm-grader`", () => {
    const config: Record<string, unknown> = {
      prompt: "{{input}}",
      tests: [
        { vars: { input: "x" }, assert: [{ type: "llm-rubric", value: "must be a haiku" }] },
      ],
    };
    const { errors } = validateConfigObject(config, registries);
    expect(errors).toEqual([]);
  });

  it("accepts the `hallucination-probe` plugin used by the security-scan template", () => {
    const config: Record<string, unknown> = {
      prompt: "sys",
      redteam: { plugins: ["prompt-injection", "hallucination-probe"], strategies: ["base64"] },
    };
    const { errors } = validateConfigObject(config, registries);
    expect(errors).toEqual([]);
  });

  it("still rejects a genuinely unknown scorer", () => {
    const config: Record<string, unknown> = {
      prompt: "{{input}}",
      scorers: ["definitely-not-a-scorer"],
      cases: [{ input: "x" }],
    };
    const { errors } = validateConfigObject(config, registries);
    expect(errors.some((e) => /Unknown scorer/.test(e))).toBe(true);
  });

  it("still rejects a genuinely unknown plugin", () => {
    const config: Record<string, unknown> = {
      prompt: "sys",
      redteam: { plugins: ["hallucination"] }, // the OLD (invalid) template name
    };
    const { errors } = validateConfigObject(config, registries);
    expect(errors.some((e) => /Unknown plugin/.test(e))).toBe(true);
  });
});
