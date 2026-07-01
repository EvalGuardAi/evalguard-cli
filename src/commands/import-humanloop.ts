/**
 * `evalguard import:humanloop <file>` — Import a Humanloop project export
 * and convert it to an EvalGuard config.
 *
 * Humanloop joined Anthropic in 2026 and is sunsetting their product.
 * This command is the migration path for existing customers — accepts
 * their JSON export format from `humanloop export project` or the
 * platform's "Export Project" download.
 *
 * Schema (best-effort against public humanloop schema as of 2026-05):
 *   { projects: [{ name, prompts: [{ name, template, model_config }],
 *                  datasets: [{ name, inputs }],
 *                  evaluators: [{ name, type }] }] }
 *
 * Pure-function design so every step is unit-testable. The CLI action
 * is a thin shell that reads → calls converter → writes file + summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Evaluator type mapping ──────────────────────────────────────────
// Humanloop has 3 evaluator types: `human` (manual labels), `llm`
// (model-graded), `code` (JavaScript snippet). We map to the closest
// EvalGuard scorer.

export const EVALUATOR_TYPE_MAP: Record<string, string> = {
  human: "human-annotation",
  llm: "llm-grader",
  "llm-rubric": "llm-grader",
  "model-graded": "llm-grader",
  // `code` evaluators are JavaScript snippets — no 1:1 map. Surfaced
  // via the unmapped report so the user can rewrite manually.
  // Common humanloop-built-in evaluators that DO have direct mappings:
  exact_match: "equals",
  contains: "contains",
  toxicity: "toxicity",
  bias: "bias",
  factuality: "factuality",
  relevance: "answer-relevance",
};

export const EVALUATOR_SUGGESTIONS: Record<string, string> = {
  code: "Custom JS evaluator — rewrite as an EvalGuard custom scorer (see /docs/scorers/custom)",
  custom: "Custom evaluator — see /docs/scorers/custom for the EvalGuard equivalent",
  api: "External webhook evaluator — use EvalGuard's webhook scorer or rewrite as a custom scorer",
  bleu: "Use `semantic-similarity` (closer match for LLM-output scoring)",
  rouge: "Use `semantic-similarity`",
};

// ─── Provider mapping ────────────────────────────────────────────────

export interface EvalGuardProvider {
  provider: string;
  model: string;
  config?: Record<string, unknown>;
}

/**
 * Map a Humanloop `model_config` block to EvalGuard provider form.
 *
 * Humanloop's shape:
 *   { provider: "openai", model: "gpt-4o", temperature: 0.7, max_tokens: 1000 }
 *
 * EvalGuard's shape: `{ provider, model, config? }` where `config` holds
 * everything except provider/model and the redacted API key. Keys
 * stripped: `api_key`, `apiKey`, `openai_api_key`, `anthropic_api_key`
 * — Humanloop exports can include keys; we never want them in a
 * committed evalguard.config.json.
 */
export function mapHumanloopModelConfig(raw: Record<string, unknown>): EvalGuardProvider {
  const provider = (raw.provider as string) ?? "openai";
  const model = (raw.model as string) ?? "gpt-4o";
  const SENSITIVE_KEYS = new Set([
    "api_key",
    "apiKey",
    "openai_api_key",
    "anthropic_api_key",
    "azure_api_key",
    "secret",
    "token",
  ]);
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "provider" || k === "model") continue;
    if (SENSITIVE_KEYS.has(k)) continue;
    config[k] = v;
  }
  const result: EvalGuardProvider = { provider, model };
  if (Object.keys(config).length > 0) result.config = config;
  return result;
}

// ─── Evaluator mapping ───────────────────────────────────────────────

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

export function mapHumanloopEvaluator(
  evaluator: Record<string, unknown>,
): EvalGuardScorer | null {
  // Humanloop evaluators may identify the metric by `type`, `name`, or
  // `metric` (varies by export version). Try in that order.
  const key =
    (evaluator.type as string) ??
    (evaluator.metric as string) ??
    (evaluator.name as string);
  if (!key) return null;

  const lower = key.toLowerCase();
  const mapped = EVALUATOR_TYPE_MAP[lower];
  if (!mapped) {
    // Unknown evaluator — pass through verbatim so the caller can flag it.
    return { scorer: lower, value: evaluator.value };
  }

  const scorer: EvalGuardScorer = { scorer: mapped };
  if (evaluator.threshold !== undefined) scorer.threshold = evaluator.threshold as number;
  if (evaluator.value !== undefined) scorer.value = evaluator.value;
  return scorer;
}

// ─── Full conversion ─────────────────────────────────────────────────

export interface HumanloopConversionResult {
  config: {
    name: string;
    providers: EvalGuardProvider[];
    prompts: string[];
    defaultScorers?: EvalGuardScorer[];
    cases?: Record<string, unknown>[];
  };
  promptCount: number;
  caseCount: number;
  evaluatorCount: number;
  unmappedEvaluators: string[];
  // Humanloop projects can have multiple prompts; we flatten into one
  // EvalGuard config (the first project, or the user picks via --project).
  projectsFound: string[];
}

/**
 * Convert a parsed Humanloop export object to an EvalGuard config.
 *
 * The export may be either:
 *   (a) A single-project file: `{ name, prompts, datasets, evaluators }`
 *   (b) A multi-project archive: `{ projects: [...] }`
 *
 * For (b), we pick the FIRST project unless `selectProject` is passed.
 */
export function convertHumanloopExport(
  source: Record<string, unknown>,
  options: { selectProject?: string } = {},
): HumanloopConversionResult {
  // Normalise to a single project.
  let project: Record<string, unknown>;
  const projectsFound: string[] = [];

  if (Array.isArray(source.projects)) {
    for (const p of source.projects as Record<string, unknown>[]) {
      projectsFound.push((p.name as string) ?? "(unnamed)");
    }
    if (options.selectProject) {
      const picked = (source.projects as Record<string, unknown>[]).find(
        (p) => p.name === options.selectProject,
      );
      if (!picked) {
        throw new Error(
          `Project '${options.selectProject}' not found in export. Available: ${projectsFound.join(", ")}`,
        );
      }
      project = picked;
    } else {
      project = (source.projects as Record<string, unknown>[])[0] ?? {};
    }
  } else {
    project = source;
    if (project.name) projectsFound.push(project.name as string);
  }

  // ── Prompts ──
  const rawPrompts = (project.prompts ?? []) as Record<string, unknown>[];
  // Humanloop prompt templates use {{var}} mustache — same shape as
  // EvalGuard prompt templates, so no transform needed.
  const prompts: string[] = rawPrompts
    .map((p) => (p.template as string) ?? (p.content as string))
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  // ── Providers (from prompt model_configs — dedup) ──
  const providerMap = new Map<string, EvalGuardProvider>();
  for (const p of rawPrompts) {
    const mc = (p.model_config ?? p.modelConfig) as Record<string, unknown> | undefined;
    if (!mc) continue;
    const mapped = mapHumanloopModelConfig(mc);
    const key = `${mapped.provider}:${mapped.model}`;
    if (!providerMap.has(key)) {
      providerMap.set(key, mapped);
    }
  }
  const providers = [...providerMap.values()];

  // ── Datasets → cases ──
  const datasets = (project.datasets ?? []) as Record<string, unknown>[];
  const cases: Record<string, unknown>[] = [];
  for (const ds of datasets) {
    const inputs = (ds.inputs ?? ds.rows ?? []) as Record<string, unknown>[];
    for (const row of inputs) {
      const c: Record<string, unknown> = { vars: row };
      if (ds.name) c.description = `from dataset: ${ds.name}`;
      cases.push(c);
    }
  }

  // ── Evaluators → defaultScorers ──
  const rawEvaluators = (project.evaluators ?? []) as Record<string, unknown>[];
  const defaultScorers: EvalGuardScorer[] = [];
  const unmappedSet = new Set<string>();
  for (const e of rawEvaluators) {
    const mapped = mapHumanloopEvaluator(e);
    if (!mapped) continue;
    defaultScorers.push(mapped);
    // Track the original key for the unmapped report.
    const key =
      (e.type as string) ??
      (e.metric as string) ??
      (e.name as string);
    if (key) {
      const lower = key.toLowerCase();
      if (!EVALUATOR_TYPE_MAP[lower]) unmappedSet.add(lower);
    }
  }

  const config: HumanloopConversionResult["config"] = {
    name: (project.name as string) ?? "Imported from Humanloop",
    providers,
    prompts,
  };
  if (defaultScorers.length > 0) config.defaultScorers = defaultScorers;
  if (cases.length > 0) config.cases = cases;

  return {
    config,
    promptCount: prompts.length,
    caseCount: cases.length,
    evaluatorCount: defaultScorers.length,
    unmappedEvaluators: [...unmappedSet].sort(),
    projectsFound,
  };
}

// ─── YAML / JSON loader (shared pattern with import-promptfoo) ───────

async function loadHumanloopFile(filePath: string): Promise<Record<string, unknown>> {
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content);
  } catch {
    try {
      const yamlMod = await import("yaml");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parse = (yamlMod as any).parse ?? (yamlMod as any).default?.parse;
      if (parse) return parse(content) as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new Error(
      "Could not parse file as JSON or YAML. Humanloop exports are JSON by default — try " +
        "'humanloop export project --format=json'.",
    );
  }
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportHumanloop(program: Command): void {
  program
    .command("import:humanloop")
    .description("Migrate a Humanloop project export to an EvalGuard config")
    .argument("<file>", "Path to Humanloop project export (JSON or YAML)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--project <name>", "Pick a specific project when the export contains multiple")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(
      async (
        file: string,
        opts: { output: string; project?: string; dryRun?: boolean },
      ) => {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
          console.error(chalk.red(`File not found: ${filePath}`));
          process.exit(1);
        }

        console.log();
        console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — Humanloop Import"));
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
        console.log();
        console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

        let source: Record<string, unknown>;
        try {
          source = await loadHumanloopFile(filePath);
        } catch (err) {
          console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
          process.exit(1);
        }

        let result: HumanloopConversionResult;
        try {
          result = convertHumanloopExport(source, { selectProject: opts.project });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        if (result.projectsFound.length > 1 && !opts.project) {
          console.log(chalk.yellow(
            `  Note: ${result.projectsFound.length} projects in export — converted the first ('${result.projectsFound[0]}').`,
          ));
          console.log(chalk.dim(
            `  Use --project=<name> to pick another. Available: ${result.projectsFound.join(", ")}`,
          ));
        }

        console.log();
        console.log(chalk.bold("  Conversion Summary:"));
        console.log(`    ${chalk.green("✓")} ${result.config.providers.length} provider(s) deduped from prompt model_configs`);
        console.log(`    ${chalk.green("✓")} ${result.promptCount} prompt(s) migrated`);
        console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) flattened from datasets`);
        console.log(`    ${chalk.green("✓")} ${result.evaluatorCount} evaluator(s) mapped`);

        if (result.unmappedEvaluators.length > 0) {
          console.log();
          console.log(chalk.yellow(`  ${result.unmappedEvaluators.length} evaluator type(s) without a direct mapping:`));
          for (const type of result.unmappedEvaluators) {
            const suggestion = EVALUATOR_SUGGESTIONS[type];
            const line = `    ${chalk.yellow("!")} ${chalk.bold(type)}`;
            if (suggestion) {
              console.log(`${line} ${chalk.dim("→")} ${chalk.cyan(suggestion)}`);
            } else {
              console.log(`${line} ${chalk.dim("(passed through verbatim — review before running)")}`);
            }
          }
        }

        if (opts.dryRun) {
          console.log();
          console.log(chalk.dim("  --- Dry Run Output ---"));
          console.log(JSON.stringify(result.config, null, 2));
          console.log();
          return;
        }

        const outputPath = path.resolve(opts.output);
        fs.writeFileSync(outputPath, JSON.stringify(result.config, null, 2), "utf-8");

        console.log();
        console.log(`  ${chalk.green("✓")} Written to ${chalk.cyan(opts.output)}`);
        console.log();
        console.log(chalk.bold("  Next steps:"));
        console.log(`    1. Review ${chalk.cyan(opts.output)} — manually re-create any 'code' evaluators`);
        console.log(`    2. Run: ${chalk.cyan("npx evalguard eval " + opts.output)}`);
        console.log(`    3. Try: ${chalk.cyan("npx evalguard scan")} for 249+ red team attacks`);
        console.log();
        console.log(chalk.dim("  Full migration guide: https://evalguard.ai/migrate-from-humanloop"));
        console.log();
      },
    );
}
