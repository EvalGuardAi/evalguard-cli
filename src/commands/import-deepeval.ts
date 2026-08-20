/**
 * `evalguard import:deepeval <file>` — Import a DeepEval golden dataset and
 * convert it to an EvalGuard config.
 *
 * DeepEval (confident-ai/deepeval) is an OSS pytest-style LLM-eval framework.
 * Its `EvaluationDataset` holds `goldens` (input → expected pairs, optionally
 * with RAG `context` / `retrieval_context`) and `LLMTestCase`s. Calling
 * `dataset.save_as('json', dir)` writes the goldens as a JSON file. This
 * command is the migration path for customers moving their DeepEval golden
 * datasets into EvalGuard.
 *
 * Accepted export shapes (clean-room — built from DeepEval's PUBLIC dataset /
 * golden serialization, no DeepEval code is used):
 *   (a) A bare array `[{ input, expected_output? }]` — what `save_as('json')`
 *       writes.
 *   (b) `{ goldens: [...] }` — the EvaluationDataset envelope.
 *   (c) `{ test_cases: [...] }` — a dataset serialized from LLMTestCases.
 *   (d) A single golden object `{ input, expected_output? }`.
 *
 * DeepEval *metrics* (GEval, AnswerRelevancy, Faithfulness, Hallucination, …)
 * are Python CODE — they don't ship inside a dataset export — so we do NOT
 * invent scorer mappings for them. The "Next steps" block points the user at
 * EvalGuard custom scorers (mirrors how `import:braintrust` / `import:langsmith`
 * handle unmappable evaluators). When a golden carries a reference value
 * (`expected_output`) we attach a single `equals` default scorer so the
 * converted config is immediately runnable, and flag it for review.
 *
 * Pure-function design so every step is unit-testable. The CLI action is a
 * thin shell that reads → calls converter → writes file + summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Secret stripping ────────────────────────────────────────────────
// DeepEval golden `input` / `expected_output` / `additional_metadata` can
// carry a captured api key (e.g. a config blob logged alongside a case). We
// never want one in a checked-in evalguard.config.json, so we recursively strip
// secret-ish keys from EVERYTHING we write. Exact-key matches (case-insensitive)
// plus a conservative regex that catches `*_api_key` / `*_secret` /
// `access_token` style keys without false-positiving on `total_tokens` /
// `token_count`. (Same policy as import:braintrust.)

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
  "confident_api_key",
  "deepeval_api_key",
  "langchain_api_key",
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

// ─── Reference-value mapping ─────────────────────────────────────────

/**
 * Map a DeepEval golden's `expected_output` to the EvalGuard case's `expected`
 * string. `expected_output` is the reference value directly. We normalize
 * consistently with `import:braintrust`: a string/number/boolean passes
 * through; a single-key object yields that key's value (the primary reference
 * answer); anything else (multi-key object, array) is preserved whole.
 * Non-string leaf values are JSON-stringified so `expected` is always a string.
 */
export function mapReferenceOutput(expected: unknown): string | undefined {
  if (expected === null || expected === undefined) return undefined;
  if (typeof expected === "string") return expected;
  if (typeof expected === "number" || typeof expected === "boolean") return String(expected);
  if (Array.isArray(expected)) return expected.length > 0 ? JSON.stringify(expected) : undefined;
  if (typeof expected === "object") {
    const entries = Object.entries(expected as Record<string, unknown>);
    if (entries.length === 0) return undefined;
    if (entries.length === 1) {
      const v = entries[0][1];
      if (v === null || v === undefined) return undefined;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    return JSON.stringify(expected);
  }
  return undefined;
}

/**
 * Coerce a DeepEval golden's `input` into an EvalGuard case `vars` object.
 * DeepEval inputs are usually a bare string (the user query) but can be a dict;
 * a bare primitive/array is wrapped under `input` so `vars` is always a
 * `Record`. `context` / `retrieval_context` (RAG grounding a prompt template
 * will reference) are preserved as vars alongside the input.
 */
function toVars(
  rawInput: unknown,
  context: unknown,
  retrievalContext: unknown,
  removed: Set<string>,
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  if (rawInput !== undefined && rawInput !== null) {
    const stripped = stripSecrets(rawInput, removed);
    if (stripped && typeof stripped === "object" && !Array.isArray(stripped)) {
      Object.assign(vars, stripped as Record<string, unknown>);
    } else {
      vars.input = stripped;
    }
  }
  // Preserve RAG grounding — it's what a prompt template interpolates for
  // context-aware evals, so dropping it would silently break the migrated case.
  if (context !== undefined && context !== null) {
    vars.context = stripSecrets(context, removed);
  }
  if (retrievalContext !== undefined && retrievalContext !== null) {
    vars.retrieval_context = stripSecrets(retrievalContext, removed);
  }
  return vars;
}

// ─── Full conversion ─────────────────────────────────────────────────

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

export interface DeepEvalConversionResult {
  config: {
    name: string;
    description?: string;
    prompt: string;
    cases: Record<string, unknown>[];
    defaultScorers?: EvalGuardScorer[];
  };
  /** Number of records found in the export. */
  recordCount: number;
  /** Number of cases written (== records that were object-shaped). */
  caseCount: number;
  /** Cases that carried a reference value (→ `expected`). */
  withReferenceCount: number;
  /** Cases that carried RAG grounding (context / retrieval_context). */
  withContextCount: number;
  /** Distinct secret-ish keys stripped from inputs/expected/metadata. */
  strippedSecretKeys: string[];
  /**
   * True when a default `equals` scorer was injected because the dataset had
   * reference values. Surfaced so the user knows to review/replace it.
   */
  defaultScorerInjected: boolean;
}

/**
 * The default scorer attached when a DeepEval dataset carries reference
 * values. `equals` is the honest, keyless baseline for a reference dataset
 * (output vs `expected`); the user is told to swap it for the scorer that
 * matches their DeepEval metrics' intent (e.g. `semantic-similarity`,
 * `llm-grader` for a GEval-style rubric).
 */
export const DEFAULT_REFERENCE_SCORER = "equals";

/**
 * The scaffold prompt written into the converted config. A DeepEval golden
 * dataset is just input→reference pairs and carries NO prompt of its own, so we
 * emit EvalGuard's idiomatic `{{input}}` placeholder (which `validate` expects
 * and `eval:local` / `gate` interpolate from each case's `vars`). The user is
 * told in "Next steps" to replace it with their real prompt template.
 */
export const DEFAULT_PROMPT = "{{input}}";

/**
 * Convert a parsed DeepEval golden-dataset export into an EvalGuard config.
 * Pure — no I/O, no console — so it can be unit-tested in isolation.
 */
export function convertDeepEvalDataset(source: unknown): DeepEvalConversionResult {
  const records = extractRecords(source);
  const removedSecretKeys = new Set<string>();

  const cases: Record<string, unknown>[] = [];
  let withReferenceCount = 0;
  let withContextCount = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      // A non-object record (string / number / null) has no input to map —
      // skip it rather than writing a bogus empty case.
      continue;
    }
    const row = rec as Record<string, unknown>;

    if (row.context !== undefined || row.retrieval_context !== undefined) {
      withContextCount++;
    }
    const vars = toVars(row.input, row.context, row.retrieval_context, removedSecretKeys);

    const c: Record<string, unknown> = { vars };

    // DeepEval goldens use `expected_output`; tolerate the legacy `expected`.
    const rawExpected =
      row.expected_output !== undefined ? row.expected_output : row.expected;
    const strippedExpected =
      rawExpected !== undefined ? stripSecrets(rawExpected, removedSecretKeys) : undefined;
    const expected = mapReferenceOutput(strippedExpected);
    if (expected !== undefined) {
      c.expected = expected;
      withReferenceCount++;
    }

    cases.push(c);
  }

  const meta =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : undefined;
  const datasetName =
    (meta?.alias as string | undefined) ?? (meta?.name as string | undefined);
  const datasetDescription = meta?.description as string | undefined;

  const config: DeepEvalConversionResult["config"] = {
    name: typeof datasetName === "string" && datasetName.length > 0 ? datasetName : "Imported from DeepEval",
    prompt: DEFAULT_PROMPT,
    cases,
  };
  if (typeof datasetDescription === "string" && datasetDescription.length > 0) {
    config.description = datasetDescription;
  }

  // Attach a runnable default scorer ONLY when reference values exist — that
  // is what makes the config valid + runnable (`validate`/`gate` require at
  // least one scorer). We do NOT synthesize scorers from DeepEval metrics
  // (arbitrary Python code); those are surfaced as a next step instead.
  const defaultScorerInjected = withReferenceCount > 0;
  if (defaultScorerInjected) {
    config.defaultScorers = [{ scorer: DEFAULT_REFERENCE_SCORER }];
  }

  return {
    config,
    recordCount: records.length,
    caseCount: cases.length,
    withReferenceCount,
    withContextCount,
    strippedSecretKeys: [...removedSecretKeys].sort(),
    defaultScorerInjected,
  };
}

function extractRecords(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    const obj = source as { goldens?: unknown[]; test_cases?: unknown[]; input?: unknown };
    if (Array.isArray(obj.goldens)) return obj.goldens;
    if (Array.isArray(obj.test_cases)) return obj.test_cases;
    // A single golden object (has `input`) — treat as a one-record dataset.
    if (obj.input !== undefined) return [source];
    return [];
  }
  return [];
}

// ─── JSON / YAML loader (shared pattern with import-braintrust) ──────

type YamlParse = (s: string) => unknown;

/**
 * Load a DeepEval dataset export from disk as JSON (the default) or YAML.
 * As with the braintrust loader, the failure modes are DISTINCT: a genuinely
 * missing `yaml` module is reported as unavailable, but when `yaml` IS present
 * and the file is malformed the real parser error (line/column) is surfaced.
 * Exported so the loader's error contract can be unit-tested directly.
 */
export async function loadDeepEvalFile(filePath: string): Promise<unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Not JSON — DeepEval exports are JSON by default, but accept YAML too.
  }

  const jsonHint =
    "DeepEval exports are JSON by default — export the dataset with `dataset.save_as('json', directory)` or pull it from Confident AI.";
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
      `Invalid DeepEval export (not valid JSON or YAML): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportDeepeval(program: Command): void {
  program
    .command("import:deepeval")
    .description("Migrate a DeepEval golden dataset export to an EvalGuard config")
    .argument("<file>", "Path to a DeepEval dataset export (JSON or YAML)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(async (file: string, opts: { output: string; dryRun?: boolean }) => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — DeepEval Import"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

      let source: unknown;
      try {
        source = await loadDeepEvalFile(filePath);
      } catch (err) {
        console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = convertDeepEvalDataset(source);

      // ── Summary ──
      console.log();
      console.log(chalk.bold("  Conversion Summary:"));
      console.log(`    ${chalk.green("✓")} ${result.recordCount} golden(s) read`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) converted`);
      console.log(`    ${chalk.green("✓")} ${result.withReferenceCount} case(s) with a reference value (→ expected)`);
      if (result.withContextCount > 0) {
        console.log(`    ${chalk.green("✓")} ${result.withContextCount} case(s) with RAG grounding (context / retrieval_context) preserved in vars`);
      }
      if (result.strippedSecretKeys.length > 0) {
        console.log(
          `    ${chalk.green("✓")} stripped ${result.strippedSecretKeys.length} secret-ish key(s): ${chalk.dim(result.strippedSecretKeys.join(", "))}`,
        );
      }
      if (result.defaultScorerInjected) {
        console.log(
          `    ${chalk.green("✓")} added default scorer ${chalk.bold(DEFAULT_REFERENCE_SCORER)} (dataset has reference values)`,
        );
      }

      // ── Next steps note (mirrors braintrust's unmapped-suggestion block) ──
      console.log();
      console.log(chalk.yellow("  DeepEval metrics are Python code — not migrated automatically:"));
      console.log(
        `    ${chalk.yellow("!")} Re-create each DeepEval metric (GEval / AnswerRelevancy / Faithfulness / Hallucination / …) as an EvalGuard scorer ${chalk.dim("→")} ${chalk.cyan("/docs/scorers/custom")}`,
      );
      console.log(
        `    ${chalk.yellow("!")} For a GEval-style rubric, try ${chalk.cyan("llm-grader")}; for AnswerRelevancy-style similarity, try ${chalk.cyan("semantic-similarity")}`,
      );
      if (result.defaultScorerInjected) {
        console.log(
          `    ${chalk.yellow("!")} Review the injected ${chalk.bold(DEFAULT_REFERENCE_SCORER)} scorer — swap for ${chalk.cyan("semantic-similarity")} / ${chalk.cyan("llm-grader")} if exact match is too strict`,
        );
      } else {
        console.log(
          `    ${chalk.yellow("!")} No reference values found — add a ${chalk.cyan("scorers")}/${chalk.cyan("defaultScorers")} block before running`,
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
        `    1. Review ${chalk.cyan(opts.output)} — set your ${chalk.cyan("prompt")} template + re-create your DeepEval metrics as scorers`,
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
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/migrate-from-deepeval"));
      console.log();
    });
}
