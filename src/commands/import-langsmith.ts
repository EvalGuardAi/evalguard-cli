/**
 * `evalguard import:langsmith <file>` — Import a LangSmith dataset export
 * and convert it to an EvalGuard config.
 *
 * LangSmith (LangChain's eval + observability platform) stores test data
 * as *datasets* of *examples*, where each example is an
 * `{ inputs, outputs?, metadata? }` pair. This command is the migration
 * path for customers moving their reference datasets into EvalGuard.
 *
 * Accepted export shapes (clean-room — built from LangSmith's PUBLIC
 * dataset/example schema on https://api.smith.langchain.com, no LangSmith
 * code is used):
 *   (a) `{ name?, description?, examples: [{ id?, inputs, outputs?, metadata? }] }`
 *   (b) A bare array `[{ inputs, outputs? }]`
 *   (c) `{ data: [...] }`
 *   (d) A single example object `{ inputs, outputs? }`
 *
 * LangSmith *evaluators* are arbitrary user code (Python/JS functions or
 * LLM-as-judge prompts) that don't ship inside a dataset export, so we do
 * NOT invent scorer mappings for them — the "Next steps" block points the
 * user at EvalGuard custom scorers instead, the same treatment our sibling
 * `import:promptfoo` command gives an inline `python` assertion. When a
 * dataset carries reference outputs
 * we attach a single `equals` default scorer so the converted config is
 * immediately runnable, and flag it for review.
 *
 * Pure-function design so every step is unit-testable. The CLI action is a
 * thin shell that reads → calls converter → writes file + summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Secret stripping ────────────────────────────────────────────────
// LangSmith example inputs/outputs/metadata occasionally carry a captured
// api key (e.g. a config blob logged alongside a run). We never want one in
// a checked-in evalguard.config.json, so we recursively strip secret-ish
// keys from EVERYTHING we write. Exact-key matches (case-insensitive) plus a
// conservative regex that catches `*_api_key` / `*_secret` / `access_token`
// style keys without false-positiving on `total_tokens` / `token_count`.

const SECRET_EXACT_KEYS = new Set([
  "api_key",
  "apikey",
  "openai_api_key",
  "anthropic_api_key",
  "azure_api_key",
  "google_api_key",
  "cohere_api_key",
  "mistral_api_key",
  "huggingface_api_key",
  "hf_token",
  "langchain_api_key",
  "langsmith_api_key",
  "ls_api_key",
  "secret",
  "client_secret",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "session_token",
  "authorization",
  "bearer",
  "password",
  "passwd",
  "private_key",
]);

const SECRET_KEY_REGEX =
  /(^|_|-)(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)($|_|-)/i;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_EXACT_KEYS.has(k)) return true;
  return SECRET_KEY_REGEX.test(k);
}

/**
 * Recursively remove secret-ish keys from any JSON-ish value. Records every
 * distinct key removed (via `removed`) so the CLI can report the strip count.
 */
export function stripSecrets(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v, removed));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        removed.add(k);
        continue;
      }
      out[k] = stripSecrets(v, removed);
    }
    return out;
  }
  return value;
}

// ─── Reference-output mapping ────────────────────────────────────────

/**
 * Map a LangSmith example's `outputs` to the EvalGuard case's `expected`
 * string. Per the migration contract: a single-key outputs object yields
 * that key's value (the primary reference answer); anything else (multi-key
 * object, array, already-a-string) is preserved whole. Non-string leaf
 * values are JSON-stringified so `expected` is always a string.
 */
export function mapReferenceOutput(outputs: unknown): string | undefined {
  if (outputs === null || outputs === undefined) return undefined;
  if (typeof outputs === "string") return outputs;
  if (typeof outputs === "number" || typeof outputs === "boolean") return String(outputs);
  if (Array.isArray(outputs)) return outputs.length > 0 ? JSON.stringify(outputs) : undefined;
  if (typeof outputs === "object") {
    const entries = Object.entries(outputs as Record<string, unknown>);
    if (entries.length === 0) return undefined;
    if (entries.length === 1) {
      const v = entries[0][1];
      if (v === null || v === undefined) return undefined;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    return JSON.stringify(outputs);
  }
  return undefined;
}

/**
 * Coerce a LangSmith example's `inputs` into an EvalGuard case `vars` object.
 * Inputs are normally a dict; a bare primitive/array is wrapped under `input`
 * so `vars` is always a `Record`.
 */
function toVars(rawInputs: unknown, removed: Set<string>): Record<string, unknown> {
  if (rawInputs === undefined || rawInputs === null) return {};
  const stripped = stripSecrets(rawInputs, removed);
  if (stripped && typeof stripped === "object" && !Array.isArray(stripped)) {
    return stripped as Record<string, unknown>;
  }
  return { input: stripped };
}

// ─── Full conversion ─────────────────────────────────────────────────

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

export interface LangSmithConversionResult {
  config: {
    name: string;
    description?: string;
    prompt: string;
    cases: Record<string, unknown>[];
    defaultScorers?: EvalGuardScorer[];
  };
  /** Number of examples found in the export. */
  exampleCount: number;
  /** Number of cases written (== examples that were object-shaped). */
  caseCount: number;
  /** Cases that carried a reference output (→ `expected`). */
  withReferenceCount: number;
  /** Distinct secret-ish keys stripped from inputs/outputs/metadata. */
  strippedSecretKeys: string[];
  /**
   * True when a default `equals` scorer was injected because the dataset had
   * reference outputs. Surfaced so the user knows to review/replace it.
   */
  defaultScorerInjected: boolean;
}

/**
 * The default scorer attached when a LangSmith dataset carries reference
 * outputs. `equals` is the honest, keyless baseline for a reference dataset
 * (output vs `expected`); the user is told to swap it for the scorer that
 * matches their LangSmith evaluators' intent (e.g. `semantic-similarity`,
 * `llm-grader`).
 */
export const DEFAULT_REFERENCE_SCORER = "equals";

/**
 * The scaffold prompt written into the converted config. A LangSmith dataset
 * is just input→reference pairs and carries NO prompt of its own, so we emit
 * EvalGuard's idiomatic `{{input}}` placeholder (which `validate` expects and
 * `eval:local` / `gate` interpolate from each case's `vars`). The user is told
 * in "Next steps" to replace it with their real prompt template.
 */
export const DEFAULT_PROMPT = "{{input}}";

/**
 * Convert a parsed LangSmith dataset export into an EvalGuard config.
 * Pure — no I/O, no console — so it can be unit-tested in isolation.
 */
export function convertLangSmithDataset(source: unknown): LangSmithConversionResult {
  const examples = extractExamples(source);
  const removedSecretKeys = new Set<string>();

  const cases: Record<string, unknown>[] = [];
  let withReferenceCount = 0;

  for (const ex of examples) {
    if (!ex || typeof ex !== "object" || Array.isArray(ex)) {
      // A non-object example (string / number / null) has no inputs to map —
      // skip it rather than writing a bogus empty case.
      continue;
    }
    const rec = ex as Record<string, unknown>;
    const vars = toVars(rec.inputs, removedSecretKeys);

    const c: Record<string, unknown> = { vars };

    // LangSmith uses `outputs`; some legacy exports use `output`.
    const rawOutputs = rec.outputs !== undefined ? rec.outputs : rec.output;
    const strippedOutputs =
      rawOutputs !== undefined ? stripSecrets(rawOutputs, removedSecretKeys) : undefined;
    const expected = mapReferenceOutput(strippedOutputs);
    if (expected !== undefined) {
      c.expected = expected;
      withReferenceCount++;
    }

    cases.push(c);
  }

  const datasetName =
    source && typeof source === "object" && !Array.isArray(source)
      ? ((source as Record<string, unknown>).name as string | undefined)
      : undefined;
  const datasetDescription =
    source && typeof source === "object" && !Array.isArray(source)
      ? ((source as Record<string, unknown>).description as string | undefined)
      : undefined;

  const config: LangSmithConversionResult["config"] = {
    name: datasetName ?? "Imported from LangSmith",
    prompt: DEFAULT_PROMPT,
    cases,
  };
  if (typeof datasetDescription === "string" && datasetDescription.length > 0) {
    config.description = datasetDescription;
  }

  // Attach a runnable default scorer ONLY when reference outputs exist — that
  // is what makes the config valid + runnable (`validate`/`gate` require at
  // least one scorer). We do NOT synthesize scorers from LangSmith evaluators
  // (arbitrary code); those are surfaced as a next step instead.
  const defaultScorerInjected = withReferenceCount > 0;
  if (defaultScorerInjected) {
    config.defaultScorers = [{ scorer: DEFAULT_REFERENCE_SCORER }];
  }

  return {
    config,
    exampleCount: examples.length,
    caseCount: cases.length,
    withReferenceCount,
    strippedSecretKeys: [...removedSecretKeys].sort(),
    defaultScorerInjected,
  };
}

function extractExamples(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    const obj = source as { examples?: unknown[]; data?: unknown[]; inputs?: unknown };
    if (Array.isArray(obj.examples)) return obj.examples;
    if (Array.isArray(obj.data)) return obj.data;
    // A single example object (has `inputs`) — treat as a one-example dataset.
    if (obj.inputs !== undefined) return [source];
    return [];
  }
  return [];
}

// ─── JSON / YAML loader (shared pattern with import-humanloop) ───────

type YamlParse = (s: string) => unknown;

/**
 * Load a LangSmith dataset export from disk as JSON (the default) or YAML.
 * As with the humanloop loader, the failure modes are DISTINCT: a genuinely
 * missing `yaml` module is reported as unavailable, but when `yaml` IS present
 * and the file is malformed the real parser error (line/column) is surfaced.
 * Exported so the loader's error contract can be unit-tested directly.
 */
export async function loadLangSmithFile(filePath: string): Promise<unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Not JSON — LangSmith exports are JSON by default, but accept YAML too.
  }

  const jsonHint =
    "LangSmith exports are JSON by default — export the dataset with the LangSmith SDK's `client.list_examples(...)` or the 'Download' button.";
  let parse: YamlParse | undefined;
  try {
    const yamlMod = await import("yaml");
    parse =
      (yamlMod as { parse?: YamlParse }).parse ??
      (yamlMod as { default?: { parse?: YamlParse } }).default?.parse;
  } catch {
    throw new Error(`Could not parse file as JSON, and the 'yaml' package is unavailable. ${jsonHint}`);
  }
  if (typeof parse !== "function") {
    throw new Error(`Could not parse file as JSON, and the 'yaml' package is unavailable. ${jsonHint}`);
  }

  try {
    return parse(content) as unknown;
  } catch (err) {
    throw new Error(
      `Invalid LangSmith export (not valid JSON or YAML): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportLangsmith(program: Command): void {
  program
    .command("import:langsmith")
    .description("Migrate a LangSmith dataset export to an EvalGuard config")
    .argument("<file>", "Path to a LangSmith dataset export (JSON or YAML)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(async (file: string, opts: { output: string; dryRun?: boolean }) => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — LangSmith Import"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

      let source: unknown;
      try {
        source = await loadLangSmithFile(filePath);
      } catch (err) {
        console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = convertLangSmithDataset(source);

      // ── Summary ──
      console.log();
      console.log(chalk.bold("  Conversion Summary:"));
      console.log(`    ${chalk.green("✓")} ${result.exampleCount} example(s) read`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) converted`);
      console.log(`    ${chalk.green("✓")} ${result.withReferenceCount} case(s) with a reference output (→ expected)`);
      if (result.strippedSecretKeys.length > 0) {
        console.log(
          `    ${chalk.green("✓")} stripped ${result.strippedSecretKeys.length} secret-ish key(s): ${chalk.dim(result.strippedSecretKeys.join(", "))}`,
        );
      }
      if (result.defaultScorerInjected) {
        console.log(
          `    ${chalk.green("✓")} added default scorer ${chalk.bold(DEFAULT_REFERENCE_SCORER)} (dataset has reference outputs)`,
        );
      }

      // ── Next steps note: what could NOT be mapped, and what to do about it ──
      console.log();
      console.log(chalk.yellow("  LangSmith evaluators are arbitrary code — not migrated automatically:"));
      console.log(
        `    ${chalk.yellow("!")} Re-create each LangSmith evaluator as an EvalGuard scorer ${chalk.dim("→")} ${chalk.cyan("/docs/scorers/custom")}`,
      );
      if (result.defaultScorerInjected) {
        console.log(
          `    ${chalk.yellow("!")} Review the injected ${chalk.bold(DEFAULT_REFERENCE_SCORER)} scorer — swap for ${chalk.cyan("semantic-similarity")} / ${chalk.cyan("llm-grader")} if exact match is too strict`,
        );
      } else {
        console.log(
          `    ${chalk.yellow("!")} No reference outputs found — add a ${chalk.cyan("scorers")}/${chalk.cyan("defaultScorers")} block before running`,
        );
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
      console.log(
        `    1. Review ${chalk.cyan(opts.output)} — set your ${chalk.cyan("prompt")} template + re-create your LangSmith evaluators as scorers`,
      );
      // `eval:local` is the keyless local runner and reads the converted
      // cases/defaultScorers shape directly. Plain `eval` is server-backed and
      // fails keyless with "Could not resolve a default project", so point the
      // cloud path at `eval --project <id>`.
      console.log(`    2. Run locally (no API key): ${chalk.cyan("npx @evalguard/cli eval:local " + opts.output)}`);
      console.log(`       Or gate a build (keyless): ${chalk.cyan("npx @evalguard/cli gate " + opts.output + " --provider echo")}`);
      console.log(`       Or run in the cloud:      ${chalk.cyan("npx @evalguard/cli eval --project <id> " + opts.output)}`);
      console.log(`    3. Try: ${chalk.cyan("npx @evalguard/cli scan")} for 300+ red team attacks`);
      console.log();
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/migrate-from-langsmith"));
      console.log();
    });
}
