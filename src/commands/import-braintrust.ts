/**
 * `evalguard import:braintrust <file>` — Import a Braintrust dataset export
 * and convert it to an EvalGuard config.
 *
 * Braintrust (an eval + observability platform) stores test data as
 * *datasets* of records, where each record is an
 * `{ id?, input, expected?, metadata?, tags? }` row. This command is the
 * migration path for customers moving their reference datasets into EvalGuard.
 *
 * Accepted export shapes (clean-room — built from Braintrust's PUBLIC
 * dataset schema on https://www.braintrust.dev/docs, no Braintrust code is
 * used):
 *   (a) A bare array `[{ input, expected? }]`
 *   (b) `{ events: [...] }` — the dataset `.../fetch` envelope
 *   (c) `{ records: [...] }` — the SDK insert/list envelope
 *   (d) `{ data: [...] }` — the generic/BTQL export envelope
 *   (e) A single record object `{ input, expected? }`
 *
 * Braintrust *scorers* are arbitrary user code (autoevals functions, custom
 * JS/Python, or LLM-as-judge prompts) that don't ship inside a dataset
 * export, so we do NOT invent scorer mappings for them — the "Next steps"
 * block points the user at EvalGuard custom scorers instead (mirrors how
 * `import:langsmith` / `import:promptfoo` handle unmappable evaluators). When
 * a dataset carries reference values (`expected`) we attach a single `equals`
 * default scorer so the converted config is immediately runnable, and flag it
 * for review.
 *
 * Pure-function design so every step is unit-testable. The CLI action is a
 * thin shell that reads → calls converter → writes file + summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Secret stripping ────────────────────────────────────────────────
// Braintrust record inputs/expected/metadata occasionally carry a captured
// api key (e.g. a config blob logged alongside a span). We never want one in
// a checked-in evalguard.config.json, so we recursively strip secret-ish keys
// from EVERYTHING we write. Exact-key matches (case-insensitive) plus a
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
  "braintrust_api_key",
  "bt_api_key",
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
 * Map a Braintrust record's `expected` to the EvalGuard case's `expected`
 * string. Braintrust's `expected` is the reference value directly (unlike
 * LangSmith's `outputs` dict). We normalize consistently with
 * `import:langsmith`: a string/number/boolean passes through; a single-key
 * object yields that key's value (the primary reference answer); anything
 * else (multi-key object, array) is preserved whole. Non-string leaf values
 * are JSON-stringified so `expected` is always a string.
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
 * Coerce a Braintrust record's `input` into an EvalGuard case `vars` object.
 * Inputs are normally a dict; a bare primitive/array is wrapped under `input`
 * so `vars` is always a `Record`.
 */
function toVars(rawInput: unknown, removed: Set<string>): Record<string, unknown> {
  if (rawInput === undefined || rawInput === null) return {};
  const stripped = stripSecrets(rawInput, removed);
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

export interface BraintrustConversionResult {
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
  /** Distinct secret-ish keys stripped from inputs/expected/metadata. */
  strippedSecretKeys: string[];
  /**
   * True when a default `equals` scorer was injected because the dataset had
   * reference values. Surfaced so the user knows to review/replace it.
   */
  defaultScorerInjected: boolean;
}

/**
 * The default scorer attached when a Braintrust dataset carries reference
 * values. `equals` is the honest, keyless baseline for a reference dataset
 * (output vs `expected`); the user is told to swap it for the scorer that
 * matches their Braintrust scorers' intent (e.g. `semantic-similarity`,
 * `llm-grader`).
 */
export const DEFAULT_REFERENCE_SCORER = "equals";

/**
 * The scaffold prompt written into the converted config. A Braintrust dataset
 * is just input→reference pairs and carries NO prompt of its own, so we emit
 * EvalGuard's idiomatic `{{input}}` placeholder (which `validate` expects and
 * `eval:local` / `gate` interpolate from each case's `vars`). The user is told
 * in "Next steps" to replace it with their real prompt template.
 */
export const DEFAULT_PROMPT = "{{input}}";

/**
 * Convert a parsed Braintrust dataset export into an EvalGuard config.
 * Pure — no I/O, no console — so it can be unit-tested in isolation.
 */
export function convertBraintrustDataset(source: unknown): BraintrustConversionResult {
  const records = extractRecords(source);
  const removedSecretKeys = new Set<string>();

  const cases: Record<string, unknown>[] = [];
  let withReferenceCount = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      // A non-object record (string / number / null) has no input to map —
      // skip it rather than writing a bogus empty case.
      continue;
    }
    const row = rec as Record<string, unknown>;
    const vars = toVars(row.input, removedSecretKeys);

    const c: Record<string, unknown> = { vars };

    // Braintrust datasets use `expected`; tolerate the legacy `output`/`expected_output`.
    const rawExpected =
      row.expected !== undefined
        ? row.expected
        : row.expected_output !== undefined
          ? row.expected_output
          : row.output;
    const strippedExpected =
      rawExpected !== undefined ? stripSecrets(rawExpected, removedSecretKeys) : undefined;
    const expected = mapReferenceOutput(strippedExpected);
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

  const config: BraintrustConversionResult["config"] = {
    name: datasetName ?? "Imported from Braintrust",
    prompt: DEFAULT_PROMPT,
    cases,
  };
  if (typeof datasetDescription === "string" && datasetDescription.length > 0) {
    config.description = datasetDescription;
  }

  // Attach a runnable default scorer ONLY when reference values exist — that
  // is what makes the config valid + runnable (`validate`/`gate` require at
  // least one scorer). We do NOT synthesize scorers from Braintrust scorers
  // (arbitrary code); those are surfaced as a next step instead.
  const defaultScorerInjected = withReferenceCount > 0;
  if (defaultScorerInjected) {
    config.defaultScorers = [{ scorer: DEFAULT_REFERENCE_SCORER }];
  }

  return {
    config,
    recordCount: records.length,
    caseCount: cases.length,
    withReferenceCount,
    strippedSecretKeys: [...removedSecretKeys].sort(),
    defaultScorerInjected,
  };
}

function extractRecords(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    const obj = source as { events?: unknown[]; records?: unknown[]; data?: unknown[]; input?: unknown };
    if (Array.isArray(obj.events)) return obj.events;
    if (Array.isArray(obj.records)) return obj.records;
    if (Array.isArray(obj.data)) return obj.data;
    // A single record object (has `input`) — treat as a one-record dataset.
    if (obj.input !== undefined) return [source];
    return [];
  }
  return [];
}

// ─── JSON / YAML loader (shared pattern with import-langsmith) ───────

type YamlParse = (s: string) => unknown;

/**
 * Load a Braintrust dataset export from disk as JSON (the default) or YAML.
 * As with the langsmith loader, the failure modes are DISTINCT: a genuinely
 * missing `yaml` module is reported as unavailable, but when `yaml` IS present
 * and the file is malformed the real parser error (line/column) is surfaced.
 * Exported so the loader's error contract can be unit-tested directly.
 */
export async function loadBraintrustFile(filePath: string): Promise<unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Not JSON — Braintrust exports are JSON by default, but accept YAML too.
  }

  const jsonHint =
    "Braintrust exports are JSON by default — export the dataset with the Braintrust SDK (`dataset.fetch()` / `initDataset(...)`) or the API's project-logs/dataset fetch endpoint.";
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
      `Invalid Braintrust export (not valid JSON or YAML): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportBraintrust(program: Command): void {
  program
    .command("import:braintrust")
    .description("Migrate a Braintrust dataset export to an EvalGuard config")
    .argument("<file>", "Path to a Braintrust dataset export (JSON or YAML)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(async (file: string, opts: { output: string; dryRun?: boolean }) => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — Braintrust Import"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

      let source: unknown;
      try {
        source = await loadBraintrustFile(filePath);
      } catch (err) {
        console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = convertBraintrustDataset(source);

      // ── Summary ──
      console.log();
      console.log(chalk.bold("  Conversion Summary:"));
      console.log(`    ${chalk.green("✓")} ${result.recordCount} record(s) read`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) converted`);
      console.log(`    ${chalk.green("✓")} ${result.withReferenceCount} case(s) with a reference value (→ expected)`);
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

      // ── Next steps note (mirrors langsmith's unmapped-suggestion block) ──
      console.log();
      console.log(chalk.yellow("  Braintrust scorers are arbitrary code — not migrated automatically:"));
      console.log(
        `    ${chalk.yellow("!")} Re-create each Braintrust scorer (autoevals / custom / LLM-as-judge) as an EvalGuard scorer ${chalk.dim("→")} ${chalk.cyan("/docs/scorers/custom")}`,
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
        `    1. Review ${chalk.cyan(opts.output)} — set your ${chalk.cyan("prompt")} template + re-create your Braintrust scorers as scorers`,
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
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/migrate-from-braintrust"));
      console.log();
    });
}
