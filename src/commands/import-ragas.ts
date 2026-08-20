/**
 * `evalguard import:ragas <file>` — Import a Ragas evaluation dataset and
 * convert it to an EvalGuard config.
 *
 * Ragas (explodinggradients/ragas) is an OSS RAG-evaluation framework. Its
 * `EvaluationDataset` holds samples — a question / retrieved contexts / answer /
 * reference tuple — and `dataset.to_jsonl()` / `to_pandas()` / a plain
 * `json.dump` serialize them. This command is the migration path for customers
 * moving their Ragas datasets into EvalGuard so they can run them keyless.
 *
 * Accepted export shapes (clean-room — built from Ragas's PUBLIC dataset /
 * sample serialization, no Ragas code is used):
 *   (a) A bare array `[{ user_input, reference? }]`.
 *   (b) `{ samples: [...] }` — the `EvaluationDataset` envelope.
 *   (c) `{ data: [...] }` — a generic export envelope.
 *   (d) A single sample object `{ user_input, reference? }`.
 *
 * Field-name variants across Ragas versions are supported: old (≤0.1) uses
 * `question` / `contexts` / `ground_truth`(/`ground_truths`); new (≥0.2) uses
 * `user_input` / `retrieved_contexts` / `reference` (+ `reference_contexts`).
 * Both resolve to the same neutral case shape.
 *
 * Ragas *metrics* (faithfulness, answer_relevancy, context_precision,
 * context_recall, …) are computed by Python CODE at evaluate() time — they
 * don't ship inside a dataset export — so we do NOT invent scorer mappings for
 * them. The "Next steps" block points the user at the closest EvalGuard scorers
 * (`semantic-similarity` / `llm-grader` / RAG scorers). When a sample carries a
 * reference (`reference` / `ground_truth`) we attach a single `equals` default
 * scorer so the converted config is immediately runnable, and flag it for review.
 *
 * Pure-function design so every step is unit-testable. The CLI action is a
 * thin shell that reads → calls converter → writes file + summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Secret stripping ────────────────────────────────────────────────
// A Ragas sample's `user_input` / `reference` / metadata can carry a captured
// api key (e.g. a config blob logged alongside a case). We never want one in a
// checked-in evalguard.config.json, so we recursively strip secret-ish keys
// from EVERYTHING we write. Exact-key matches (case-insensitive) plus a
// conservative regex that catches `*_api_key` / `*_secret` / `access_token`
// style keys without false-positiving on `total_tokens` / `token_count`.
// (Same policy as import:deepeval.)

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
  "ragas_app_token",
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
 * Map a Ragas sample's reference (`reference` / `ground_truth` /
 * `ground_truths`) to the EvalGuard case's `expected` string. Normalized
 * consistently with `import:deepeval`: a string/number/boolean passes through;
 * a single-key object yields that key's value (the primary reference answer);
 * anything else (multi-key object, array) is preserved whole. Non-string leaf
 * values are JSON-stringified so `expected` is always a string.
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
 * Coerce a Ragas sample's resolved input into an EvalGuard case `vars` object.
 * Ragas inputs are usually a bare string (the user query) but can be a dict; a
 * bare primitive/array is wrapped under `input` so `vars` is always a `Record`.
 * `retrieved_contexts` / `reference_contexts` (RAG grounding a prompt template
 * will reference) are preserved as vars alongside the input under canonical
 * keys, so an old-schema (`contexts`) and a new-schema (`retrieved_contexts`)
 * sample produce identical vars.
 */
function toVars(
  rawInput: unknown,
  retrievedContexts: unknown,
  referenceContexts: unknown,
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
  if (retrievedContexts !== undefined && retrievedContexts !== null) {
    vars.retrieved_contexts = stripSecrets(retrievedContexts, removed);
  }
  if (referenceContexts !== undefined && referenceContexts !== null) {
    vars.reference_contexts = stripSecrets(referenceContexts, removed);
  }
  return vars;
}

// ─── Full conversion ─────────────────────────────────────────────────

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

export interface RagasConversionResult {
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
  /** Cases that carried RAG grounding (retrieved_contexts / reference_contexts). */
  withContextCount: number;
  /** Distinct secret-ish keys stripped from inputs/reference/contexts. */
  strippedSecretKeys: string[];
  /**
   * True when a default `equals` scorer was injected because the dataset had
   * reference values. Surfaced so the user knows to review/replace it.
   */
  defaultScorerInjected: boolean;
}

/**
 * The default scorer attached when a Ragas dataset carries reference values.
 * `equals` is the honest, keyless baseline for a reference dataset (output vs
 * `expected`); the user is told to swap it for the scorer that matches their
 * Ragas metrics' intent (e.g. `semantic-similarity`, `llm-grader`, or a RAG
 * scorer for faithfulness/context-recall style checks).
 */
export const DEFAULT_REFERENCE_SCORER = "equals";

/**
 * The scaffold prompt written into the converted config. A Ragas dataset is
 * just input → reference (+ contexts) tuples and carries NO prompt of its own,
 * so we emit EvalGuard's idiomatic `{{input}}` placeholder (which `validate`
 * expects and `eval:local` / `gate` interpolate from each case's `vars`). The
 * user is told in "Next steps" to replace it with their real RAG prompt
 * template (which will typically also reference `{{retrieved_contexts}}`).
 */
export const DEFAULT_PROMPT = "{{input}}";

/**
 * Convert a parsed Ragas dataset export into an EvalGuard config.
 * Pure — no I/O, no console — so it can be unit-tested in isolation.
 */
export function convertRagasDataset(source: unknown): RagasConversionResult {
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

    // Resolve the version-variant fields to one neutral shape.
    const rawInput = row.user_input !== undefined ? row.user_input : row.question;
    const retrievedContexts =
      row.retrieved_contexts !== undefined ? row.retrieved_contexts : row.contexts;
    const referenceContexts = row.reference_contexts;

    if (retrievedContexts !== undefined || referenceContexts !== undefined) {
      withContextCount++;
    }
    const vars = toVars(rawInput, retrievedContexts, referenceContexts, removedSecretKeys);

    const c: Record<string, unknown> = { vars };

    // reference = reference ?? ground_truth ?? ground_truths.
    const rawReference =
      row.reference !== undefined
        ? row.reference
        : row.ground_truth !== undefined
          ? row.ground_truth
          : row.ground_truths;
    const strippedReference =
      rawReference !== undefined ? stripSecrets(rawReference, removedSecretKeys) : undefined;
    const expected = mapReferenceOutput(strippedReference);
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
    (meta?.name as string | undefined) ?? (meta?.alias as string | undefined);
  const datasetDescription = meta?.description as string | undefined;

  const config: RagasConversionResult["config"] = {
    name: typeof datasetName === "string" && datasetName.length > 0 ? datasetName : "Imported from Ragas",
    prompt: DEFAULT_PROMPT,
    cases,
  };
  if (typeof datasetDescription === "string" && datasetDescription.length > 0) {
    config.description = datasetDescription;
  }

  // Attach a runnable default scorer ONLY when reference values exist — that
  // is what makes the config valid + runnable (`validate`/`gate` require at
  // least one scorer). We do NOT synthesize scorers from Ragas metrics (which
  // are computed by Python code at evaluate() time); those are surfaced as a
  // next step instead.
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
    const obj = source as { samples?: unknown[]; data?: unknown[]; user_input?: unknown; question?: unknown };
    if (Array.isArray(obj.samples)) return obj.samples;
    if (Array.isArray(obj.data)) return obj.data;
    // A single sample object (has `user_input` or the legacy `question`).
    if (obj.user_input !== undefined || obj.question !== undefined) return [source];
    return [];
  }
  return [];
}

// ─── JSON / YAML loader (shared pattern with import-deepeval) ────────

type YamlParse = (s: string) => unknown;

/**
 * Load a Ragas dataset export from disk as JSON (the default) or YAML. As with
 * the deepeval loader, the failure modes are DISTINCT: a genuinely missing
 * `yaml` module is reported as unavailable, but when `yaml` IS present and the
 * file is malformed the real parser error (line/column) is surfaced. Exported
 * so the loader's error contract can be unit-tested directly.
 */
export async function loadRagasFile(filePath: string): Promise<unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Not JSON — Ragas exports are JSON/JSONL by default, but accept YAML too.
  }

  const jsonHint =
    "Ragas datasets serialize to JSON — export with `EvaluationDataset.to_pandas().to_json(...)` / `json.dump(dataset.to_list(), ...)`.";
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
      `Invalid Ragas export (not valid JSON or YAML): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportRagas(program: Command): void {
  program
    .command("import:ragas")
    .description("Migrate a Ragas evaluation dataset export to an EvalGuard config")
    .argument("<file>", "Path to a Ragas dataset export (JSON or YAML)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(async (file: string, opts: { output: string; dryRun?: boolean }) => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — Ragas Import"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

      let source: unknown;
      try {
        source = await loadRagasFile(filePath);
      } catch (err) {
        console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = convertRagasDataset(source);

      // ── Summary ──
      console.log();
      console.log(chalk.bold("  Conversion Summary:"));
      console.log(`    ${chalk.green("✓")} ${result.recordCount} sample(s) read`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) converted`);
      console.log(`    ${chalk.green("✓")} ${result.withReferenceCount} case(s) with a reference value (→ expected)`);
      if (result.withContextCount > 0) {
        console.log(`    ${chalk.green("✓")} ${result.withContextCount} case(s) with RAG grounding (retrieved_contexts / reference_contexts) preserved in vars`);
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

      // ── Next steps note (mirrors deepeval's unmapped-suggestion block) ──
      console.log();
      console.log(chalk.yellow("  Ragas metrics are computed at evaluate() time — not migrated automatically:"));
      console.log(
        `    ${chalk.yellow("!")} Re-create each Ragas metric (faithfulness / answer_relevancy / context_precision / context_recall / …) as an EvalGuard scorer ${chalk.dim("→")} ${chalk.cyan("/docs/scorers/custom")}`,
      );
      console.log(
        `    ${chalk.yellow("!")} For answer_relevancy / answer_similarity, try ${chalk.cyan("semantic-similarity")}; for faithfulness / a rubric, try ${chalk.cyan("llm-grader")} or the RAG scorers`,
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
        `    1. Review ${chalk.cyan(opts.output)} — set your ${chalk.cyan("prompt")} template (reference {{retrieved_contexts}}) + re-create your Ragas metrics as scorers`,
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
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/migrate-from-ragas"));
      console.log();
    });
}
