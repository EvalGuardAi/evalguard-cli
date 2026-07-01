/**
 * `evalguard validate <file>` — Validate eval/scan config files
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

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
        validateEvalConfig(config, errors, warnings, BUILT_IN_SCORERS);
      }

      if (isScan) {
        validateScanConfig(config, errors, warnings, ATTACK_TYPES, ALL_PLUGINS, ALL_STRATEGIES, ALL_GRADERS);
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

  // Harvest scorer names from per-case `assert:` blocks (init / Promptfoo
  // style) so configs without a top-level `scorers:` still validate.
  const cases = Array.isArray(config.cases) ? (config.cases as Record<string, unknown>[]) : [];
  const assertScorers = cases
    .flatMap((c) => (Array.isArray(c?.assert) ? (c.assert as Record<string, unknown>[]) : []))
    .map((a) => String(a?.scorer ?? a?.name ?? a?.type ?? ""))
    .filter(Boolean);

  // Scorers — top-level OR derived from per-case assertions
  if (config.scorers) {
    if (!Array.isArray(config.scorers)) {
      errors.push("'scorers' must be an array of strings.");
    } else {
      for (const s of config.scorers as string[]) {
        if (!availableScorers.includes(s)) {
          errors.push(`Unknown scorer: '${s}'. Available: ${availableScorers.join(", ")}`);
        }
      }
    }
  } else if (assertScorers.length > 0) {
    // Validate scorer names referenced in per-case assert blocks.
    for (const s of assertScorers) {
      if (!availableScorers.includes(s)) {
        errors.push(`Unknown scorer in assert: '${s}'. Available: ${availableScorers.join(", ")}`);
      }
    }
    // Cache derived list back onto config for the summary printout.
    (config as any).scorers = Array.from(new Set(assertScorers));
  } else {
    errors.push("Missing 'scorers' field (or per-case 'assert' blocks).");
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
