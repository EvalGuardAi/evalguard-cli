/**
 * `evalguard validate <file>` — Validate eval/scan config files
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
// The canonical Promptfoo-assertion → EvalGuard-scorer alias table. `eval:local`
// resolves assertion `type`s through this map at runtime (e.g. `llm-rubric` runs
// as `llm-grader`, `is-json` as `json-valid`), so the validator MUST accept the
// same aliases — otherwise `init` scaffolds a template whose own `validate`
// rejects `type: llm-rubric` as an "Unknown scorer" even though it runs fine.
import { ASSERTION_MAP } from "./import-promptfoo.js";

/** The `@evalguard/core` registries the validator checks names against. */
export interface ValidateRegistries {
  BUILT_IN_SCORERS: Record<string, unknown>;
  ATTACK_TYPES: { type: string }[];
  ALL_PLUGINS: { id: string }[];
  ALL_STRATEGIES: { id: string }[];
  ALL_GRADERS: { id: string }[];
}

export interface ValidationOutcome {
  errors: string[];
  warnings: string[];
  isEval: boolean;
  isScan: boolean;
}

/**
 * Pure validation of an already-parsed eval/scan config against the core
 * registries. Mutates `config` in place with the same normalisation the
 * `validate` command applies (`tests`→`cases` alias, `redteam.*` flattened onto
 * the top-level fields, derived `scorers` cached for the summary) and returns
 * the collected errors/warnings + detected type.
 *
 * Exported so the `init` templates can be asserted valid without spawning the
 * CLI (the `.action()` closure does file IO + `process.exit`).
 */
export function validateConfigObject(
  config: Record<string, unknown>,
  reg: ValidateRegistries,
): ValidationOutcome {
  // `evalguard init` and Promptfoo use `tests:` — accept it as alias.
  if (Array.isArray((config as any).tests) && !Array.isArray((config as any).cases)) {
    (config as any).cases = (config as any).tests;
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Detect config type — accept native (scorers/cases), init/Promptfoo
  // (tests/prompts), or scan (attackTypes/plugins, or the
  // `init -t security-scan` template's nested `redteam.plugins`).
  // A `redteam:` block is authoritative for scan: the security-scan
  // template also carries a `prompts:` array (the system prompt by file),
  // which would otherwise be misclassified as an eval and rejected for
  // missing scorers/cases.
  const redteam = (config as any).redteam;
  const hasRedteam = redteam != null && typeof redteam === "object";
  const isScan = "attackTypes" in config || "plugins" in config || hasRedteam;
  const isEval = !hasRedteam &&
    ("scorers" in config || "cases" in config || "tests" in config || "prompts" in config);

  if (!isEval && !isScan) {
    errors.push("Cannot determine config type. Expected 'scorers'/'cases'/'tests' (eval) or 'attackTypes'/'plugins'/'redteam' (scan).");
  }

  // The `init -t security-scan` template nests plugins/strategies under
  // `redteam:`. Flatten them onto the top-level fields the scan validator
  // (and the summary printout) already understand.
  if (hasRedteam) {
    if (!("plugins" in config) && Array.isArray(redteam.plugins)) {
      (config as any).plugins = redteam.plugins;
    }
    if (!("strategies" in config) && Array.isArray(redteam.strategies)) {
      (config as any).strategies = redteam.strategies;
    }
  }

  if (isEval) {
    validateEvalConfig(config, errors, warnings, reg.BUILT_IN_SCORERS);
  }

  if (isScan) {
    validateScanConfig(config, errors, warnings, reg.ATTACK_TYPES, reg.ALL_PLUGINS, reg.ALL_STRATEGIES, reg.ALL_GRADERS);
  }

  // Common checks
  if (!config.model && !config.provider) {
    warnings.push("No 'model' specified. Will need --model flag at runtime.");
  }

  // Accept either `prompt` (native) or `prompts:` array (init/Promptfoo).
  if (isEval) {
    const hasPrompt  = typeof (config as any).prompt === "string";
    const hasPrompts = Array.isArray((config as any).prompts) && (config as any).prompts.length > 0;
    if (!hasPrompt && !hasPrompts) errors.push("Missing 'prompt' field (or 'prompts' array).");
  }

  return { errors, warnings, isEval, isScan };
}

export function registerValidate(program: Command): void {
  program
    .command("validate")
    .description("Validate an eval or scan config file (YAML or JSON)")
    .argument("<file>", "Path to config YAML/JSON file")
    .action(async (file: string) => {
      const { BUILT_IN_SCORERS, ATTACK_TYPES, ALL_PLUGINS, ALL_STRATEGIES, ALL_GRADERS } = await import("@evalguard/core") as any;

      const filePath = path.resolve(file);

      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const isYaml = /\.(ya?ml)$/i.test(filePath);
      let config: Record<string, unknown>;
      try {
        config = isYaml ? (parseYaml(raw) as Record<string, unknown>) : JSON.parse(raw);
      } catch (err) {
        const fmt = isYaml ? "YAML" : "JSON";
        console.error(chalk.red(`Invalid ${fmt}: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
      const { errors, warnings, isEval, isScan } = validateConfigObject(config, {
        BUILT_IN_SCORERS,
        ATTACK_TYPES,
        ALL_PLUGINS,
        ALL_STRATEGIES,
        ALL_GRADERS,
      });

      // Display results
      console.log();
      if (errors.length === 0) {
        console.log(`  ${chalk.green("✓")} Config is valid (${isEval ? "eval" : "scan"})`);
      } else {
        console.log(`  ${chalk.red("✗")} Config has ${errors.length} error(s)`);
      }

      for (const err of errors) {
        console.log(`  ${chalk.red("ERROR")} ${err}`);
      }
      for (const warn of warnings) {
        console.log(`  ${chalk.yellow("WARN")} ${warn}`);
      }

      if (errors.length === 0) {
        // Show summary
        if (isEval) {
          const cases = config.cases as unknown[];
          const scorers = config.scorers as string[];
          console.log(chalk.dim(`  ${cases?.length ?? 0} test cases, ${scorers?.length ?? 0} scorers`));
        }
        if (isScan) {
          const attacks = config.attackTypes as string[];
          const plugins = config.plugins as string[];
          console.log(chalk.dim(`  ${attacks?.length ?? 0} attack types, ${plugins?.length ?? 0} plugins`));
        }
      }

      console.log();
      process.exit(errors.length > 0 ? 1 : 0);
    });
}

function validateEvalConfig(config: Record<string, unknown>, errors: string[], warnings: string[], BUILT_IN_SCORERS: any): void {
  const availableScorers = Object.keys(BUILT_IN_SCORERS);
  // A scorer name is valid if it's a built-in OR a Promptfoo assertion `type`
  // the runtime aliases onto one (e.g. `llm-rubric` → `llm-grader`). Resolving
  // through ASSERTION_MAP first keeps `validate` in lockstep with what
  // `eval:local` actually runs. Identity entries (`contains` → `contains`) make
  // this a no-op for already-canonical names.
  const isKnownScorer = (s: string): boolean =>
    availableScorers.includes(s) || availableScorers.includes(ASSERTION_MAP[s]);

  // Extract a scorer NAME from a bare string ("contains") OR an object entry:
  //  - `{type: "llm-rubric"}`  — init / Promptfoo `assert:` shape
  //  - `{scorer: "contains"}`  — import:promptfoo / import:humanloop output shape
  //  - `{name: "toxicity"}`    — alternative label
  const scorerName = (s: unknown): string =>
    typeof s === "string"
      ? s
      : String((s as Record<string, unknown>)?.scorer ??
               (s as Record<string, unknown>)?.name ??
               (s as Record<string, unknown>)?.type ?? "");

  // Harvest scorer names from per-case blocks: `assert:` (init / Promptfoo)
  // AND `scorers:` (the shape `import:promptfoo`/`import:humanloop` write) so a
  // config that carries its scorers per case still validates.
  const cases = Array.isArray(config.cases) ? (config.cases as Record<string, unknown>[]) : [];
  const perCaseScorers = cases
    .flatMap((c) => [
      ...(Array.isArray(c?.assert) ? (c.assert as unknown[]) : []),
      ...(Array.isArray(c?.scorers) ? (c.scorers as unknown[]) : []),
    ])
    .map(scorerName)
    .filter(Boolean);

  // Top-level scorers: `scorers` (native) OR `defaultScorers` (the importers'
  // output). Both may hold bare strings ("contains") or objects ({scorer}).
  const hasTopScorers = config.scorers != null;
  const topLevelRaw = hasTopScorers ? config.scorers : config.defaultScorers;
  const topLevelKey = hasTopScorers ? "scorers" : "defaultScorers";

  if (topLevelRaw != null) {
    if (!Array.isArray(topLevelRaw)) {
      errors.push(`'${topLevelKey}' must be an array.`);
    } else {
      const topNames = topLevelRaw.map(scorerName).filter(Boolean);
      for (const s of topNames) {
        if (!isKnownScorer(s)) {
          errors.push(`Unknown scorer: '${s}'. Available: ${availableScorers.join(", ")}`);
        }
      }
      for (const s of perCaseScorers) {
        if (!isKnownScorer(s)) {
          errors.push(`Unknown scorer in case: '${s}'. Available: ${availableScorers.join(", ")}`);
        }
      }
      // Cache the derived union back onto config for the summary printout.
      config.scorers = Array.from(new Set([...topNames, ...perCaseScorers]));
    }
  } else if (perCaseScorers.length > 0) {
    // Validate scorer names referenced only in per-case assert/scorers blocks.
    for (const s of perCaseScorers) {
      if (!isKnownScorer(s)) {
        errors.push(`Unknown scorer in case: '${s}'. Available: ${availableScorers.join(", ")}`);
      }
    }
    // Cache derived list back onto config for the summary printout.
    config.scorers = Array.from(new Set(perCaseScorers));
  } else {
    errors.push("Missing 'scorers' field (or 'defaultScorers', or per-case 'assert'/'scorers' blocks).");
  }

  // Cases — accept either `input` (native) or `vars` (Promptfoo / init).
  if (config.cases) {
    if (!Array.isArray(config.cases)) {
      errors.push("'cases' must be an array.");
    } else {
      for (let i = 0; i < (config.cases as unknown[]).length; i++) {
        const c = (config.cases as Record<string, unknown>[])[i];
        const hasInput = typeof c?.input === "string";
        const hasVars  = c?.vars && typeof c.vars === "object";
        if (!hasInput && !hasVars) {
          errors.push(`cases[${i}]: missing 'input' field (or 'vars' for init/Promptfoo style).`);
        }
      }
      if ((config.cases as unknown[]).length === 0) {
        warnings.push("'cases' is empty. Add test cases.");
      }
    }
  } else {
    errors.push("Missing 'cases' field (or 'tests' alias).");
  }

  // Prompt
  if (config.prompt && typeof config.prompt === "string") {
    if (!config.prompt.includes("{{input}}")) {
      warnings.push("Prompt doesn't contain '{{input}}' placeholder. Inputs won't be substituted.");
    }
  }
}

function validateScanConfig(config: Record<string, unknown>, errors: string[], warnings: string[], ATTACK_TYPES: any, ALL_PLUGINS: any, ALL_STRATEGIES: any, ALL_GRADERS: any): void {
  const validAttackTypes = ATTACK_TYPES.map((a: any) => a.type);
  const validPlugins = ALL_PLUGINS.map((p: any) => p.id);
  const validStrategies = ALL_STRATEGIES.map((s: any) => s.id);
  const validGraders = ALL_GRADERS.map((g: any) => g.id);

  if (config.attackTypes) {
    if (!Array.isArray(config.attackTypes)) {
      errors.push("'attackTypes' must be an array.");
    } else {
      for (const at of config.attackTypes as string[]) {
        if (!validAttackTypes.includes(at)) {
          errors.push(`Unknown attack type: '${at}'. Available: ${validAttackTypes.join(", ")}`);
        }
      }
    }
  }

  if (config.plugins) {
    if (!Array.isArray(config.plugins)) {
      errors.push("'plugins' must be an array.");
    } else {
      for (const p of config.plugins as string[]) {
        if (!validPlugins.includes(p)) {
          errors.push(`Unknown plugin: '${p}'. Available: ${validPlugins.join(", ")}`);
        }
      }
    }
  }

  if (config.strategies) {
    for (const s of config.strategies as string[]) {
      if (!validStrategies.includes(s)) {
        errors.push(`Unknown strategy: '${s}'. Available: ${validStrategies.join(", ")}`);
      }
    }
  }

  if (config.graders) {
    for (const g of config.graders as string[]) {
      if (!validGraders.includes(g)) {
        errors.push(`Unknown grader: '${g}'. Available: ${validGraders.join(", ")}`);
      }
    }
  }

  // Accept a top-level `prompt` (native) or a `prompts:` array (the
  // `init -t security-scan` template references the system prompt by file).
  const hasPrompt = typeof config.prompt === "string";
  const hasPrompts = Array.isArray((config as any).prompts) && (config as any).prompts.length > 0;
  if (!hasPrompt && !hasPrompts) {
    errors.push("Missing 'prompt' field (system prompt to test).");
  }

  if (!config.attackTypes && !config.plugins) {
    warnings.push("Neither 'attackTypes' nor 'plugins' specified. Will use all legacy attack types.");
  }
}
