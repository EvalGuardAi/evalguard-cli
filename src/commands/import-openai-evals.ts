/**
 * `evalguard import:openai-evals <file>` — convert an OpenAI Evals dataset into
 * an EvalGuard eval config.
 *
 * Clean-room — built from the PUBLIC openai/evals registry data format
 * (github.com/openai/evals), NOT from any proprietary code. A registry eval's
 * `samples.jsonl` is one JSON object per line:
 *
 *   {"input": [{"role":"system","content":"..."},{"role":"user","content":"2+2?"}], "ideal": "4"}
 *   {"input": "Capital of France?", "ideal": ["Paris", "paris"]}
 *
 * Accepted shapes:
 *   (a) JSONL — one sample per line (the canonical registry shape)
 *   (b) a JSON array of samples
 *   (c) an envelope `{ samples: [...] }` / `{ data: [...] }`
 *
 * Mapping:
 *   - `input`  → the case `vars`. A messages array collapses to the LAST user
 *                message (`vars.input`); a leading system message is preserved
 *                as `vars.system`. A bare string → `vars.input`. An object →
 *                merged into `vars`.
 *   - `ideal`  → a STRING becomes the case `expected` (+ a default `equals`
 *                scorer, the honest keyless baseline). An ARRAY (openai/evals
 *                "any of these is acceptable") becomes a per-case `contains-any`
 *                scorer over the accepted answers, so multi-answer samples grade
 *                correctly rather than collapsing to one.
 *
 * Completes the eval-interchange import set. Mirrors import:deepeval /
 * import:braintrust in flag surface, secret-stripping policy and output shape.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";

// ─── Secret-stripping (same policy as import:deepeval / import:braintrust) ───
// An OpenAI Evals sample is user-authored JSON that can carry an api_key in a
// system prompt or metadata; strip secret-ish keys from EVERYTHING we write.

const SECRET_EXACT_KEYS = new Set([
  "api_key", "apikey", "openai_api_key", "anthropic_api_key", "azure_api_key",
  "google_api_key", "cohere_api_key", "mistral_api_key", "huggingface_api_key",
  "hf_token", "langchain_api_key", "secret", "client_secret", "token",
  "access_token", "refresh_token", "id_token", "auth_token", "session_token",
  "authorization", "bearer", "password", "passwd", "private_key",
]);

const SECRET_KEY_REGEX =
  /(^|_|-)(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)($|_|-)/i;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_EXACT_KEYS.has(k)) return true;
  return SECRET_KEY_REGEX.test(k);
}

export function stripSecrets(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, removed));
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

// ─── Types ───────────────────────────────────────────────────────────

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

export interface OpenAIEvalsConversionResult {
  config: {
    name: string;
    description?: string;
    prompt: string;
    cases: Record<string, unknown>[];
    defaultScorers?: EvalGuardScorer[];
  };
  /** Samples found in the export. */
  recordCount: number;
  /** Cases written (== object-shaped samples). */
  caseCount: number;
  /** Cases that carried a single-string `ideal` (→ `expected`). */
  withReferenceCount: number;
  /** Cases whose `ideal` was a list of acceptable answers (→ contains-any). */
  withMultiIdealCount: number;
  /** Distinct secret-ish keys stripped. */
  strippedSecretKeys: string[];
  /** True when a default `equals` scorer was injected (some sample had a string ideal). */
  defaultScorerInjected: boolean;
}

/** Scaffold prompt — a samples file carries no prompt template of its own. */
export const DEFAULT_PROMPT = "{{input}}";
export const DEFAULT_REFERENCE_SCORER = "equals";
export const MULTI_IDEAL_SCORER = "contains-any";

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

/** Extract the sample list from any accepted envelope. */
function extractRecords(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    const o = source as Record<string, unknown>;
    if (Array.isArray(o.samples)) return o.samples;
    if (Array.isArray(o.data)) return o.data;
    return [source]; // a single sample object
  }
  return [];
}

/**
 * Coerce a sample `input` into a `vars` object. openai/evals inputs are either
 * a chat messages array or a bare string. From a messages array we take the
 * last user turn as `vars.input` (the actual query a `{{input}}` prompt renders)
 * and keep the first system turn as `vars.system`.
 */
function toVars(rawInput: unknown, removed: Set<string>): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const stripped = stripSecrets(rawInput, removed);

  if (Array.isArray(stripped)) {
    const msgs = stripped as ChatMessage[];
    const lastUser = [...msgs].reverse().find(
      (m) => m && typeof m === "object" && m.role === "user",
    );
    const system = msgs.find(
      (m) => m && typeof m === "object" && m.role === "system",
    );
    if (lastUser && typeof lastUser.content === "string") {
      vars.input = lastUser.content;
    } else if (msgs.length > 0) {
      // No string user turn — preserve the whole transcript so nothing is lost.
      vars.input = JSON.stringify(stripped);
    }
    if (system && typeof system.content === "string") vars.system = system.content;
    return vars;
  }
  if (stripped && typeof stripped === "object") {
    Object.assign(vars, stripped as Record<string, unknown>);
    return vars;
  }
  if (stripped !== undefined && stripped !== null) vars.input = stripped;
  return vars;
}

/**
 * Convert a parsed openai/evals samples export into an EvalGuard config.
 * Pure — no I/O, no console — so it unit-tests in isolation.
 */
export function convertOpenAIEvals(source: unknown): OpenAIEvalsConversionResult {
  const records = extractRecords(source);
  const removed = new Set<string>();
  const cases: Record<string, unknown>[] = [];
  let withReferenceCount = 0;
  let withMultiIdealCount = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    // Strip secrets from the WHOLE sample first — this both records any
    // secret-ish key found anywhere in the record (for the user report) and
    // guarantees the input/ideal we read below are clean.
    const row = stripSecrets(rec, removed) as Record<string, unknown>;
    // openai/evals uses `input`; tolerate `question`/`prompt` seen in the wild.
    const rawInput = row.input ?? row.question ?? row.prompt;
    const c: Record<string, unknown> = { vars: toVars(rawInput, removed) };

    // `ideal` (canonical) / `answer` / `expected` — the reference answer(s).
    const ideal = row.ideal ?? row.answer ?? row.expected;
    if (typeof ideal === "string") {
      c.expected = ideal;
      withReferenceCount++;
    } else if (Array.isArray(ideal) && ideal.length > 0) {
      const answers = ideal.filter((v) => typeof v === "string");
      if (answers.length > 0) {
        // "any of these is acceptable" → contains-any over the accepted set.
        c.scorers = [{ scorer: MULTI_IDEAL_SCORER, value: answers }];
        c.expected = answers[0]; // primary reference for readability
        withMultiIdealCount++;
      }
    }
    cases.push(c);
  }

  const meta =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : undefined;
  const name =
    (typeof meta?.name === "string" && meta.name) ||
    (typeof meta?.eval === "string" && meta.eval) ||
    "Imported from OpenAI Evals";

  const config: OpenAIEvalsConversionResult["config"] = {
    name,
    prompt: DEFAULT_PROMPT,
    cases,
  };
  if (typeof meta?.description === "string" && meta.description.length > 0) {
    config.description = meta.description;
  }
  // A default `equals` makes single-`ideal` cases runnable; multi-ideal cases
  // carry their own per-case contains-any scorer.
  const defaultScorerInjected = withReferenceCount > 0;
  if (defaultScorerInjected) config.defaultScorers = [{ scorer: DEFAULT_REFERENCE_SCORER }];

  return {
    config,
    recordCount: records.length,
    caseCount: cases.length,
    withReferenceCount,
    withMultiIdealCount,
    strippedSecretKeys: [...removed].sort(),
    defaultScorerInjected,
  };
}

/** Parse a file that is EITHER JSONL (one sample per line) OR a JSON array/object. */
export function parseOpenAIEvalsFile(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  // A leading [ or { that parses whole = JSON; otherwise treat as JSONL.
  if (trimmed[0] === "[" || trimmed[0] === "{") {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to JSONL (some files are a stream of {...} objects)
    }
  }
  const rows: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    rows.push(JSON.parse(l)); // throw on a genuinely malformed line — surfaced to the user
  }
  return rows;
}

export function registerImportOpenaiEvals(program: Command): void {
  program
    .command("import:openai-evals")
    .description("Import an OpenAI Evals dataset (samples.jsonl) and convert to an EvalGuard config")
    .argument("<file>", "Path to an OpenAI Evals samples file (JSONL or JSON)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(async (file: string, opts: { output: string; dryRun?: boolean }) => {
      console.log();
      console.log(`${chalk.bold.cyan("  EvalGuard")}${chalk.dim(" — OpenAI Evals Import")}`);
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();

      if (!fs.existsSync(file)) {
        console.error(chalk.red(`  ✖ File not found: ${file}`));
        process.exitCode = 1;
        return;
      }

      let source: unknown;
      try {
        source = parseOpenAIEvalsFile(fs.readFileSync(file, "utf-8"));
      } catch (err) {
        console.error(chalk.red(`  ✖ Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
        return;
      }

      const result = convertOpenAIEvals(source);
      console.log(`    ${chalk.green("✓")} ${result.recordCount} sample(s) read`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) converted`);
      if (result.withReferenceCount > 0) {
        console.log(`    ${chalk.green("✓")} ${result.withReferenceCount} case(s) with a string ideal ${chalk.dim("(→ expected + equals)")}`);
      }
      if (result.withMultiIdealCount > 0) {
        console.log(`    ${chalk.green("✓")} ${result.withMultiIdealCount} case(s) with multiple accepted answers ${chalk.dim("(→ contains-any)")}`);
      }
      if (result.strippedSecretKeys.length > 0) {
        console.log(`    ${chalk.yellow("!")} Stripped secret-ish keys: ${chalk.dim(result.strippedSecretKeys.join(", "))}`);
      }
      if (result.caseCount === 0) {
        console.log(`    ${chalk.yellow("!")} No object-shaped samples found — is this an openai/evals samples file?`);
      }

      if (opts.dryRun) {
        console.log();
        console.log(JSON.stringify(result.config, null, 2));
        return;
      }

      fs.writeFileSync(opts.output, JSON.stringify(result.config, null, 2), "utf-8");
      console.log();
      console.log(`  ${chalk.green("✓")} Written to ${chalk.cyan(opts.output)}`);
      console.log();
      console.log(`  ${chalk.bold("Next steps:")}`);
      console.log(`    1. Review ${chalk.cyan(opts.output)} — set your ${chalk.cyan("prompt")} template (the scaffold is ${chalk.dim("{{input}}")})`);
      console.log(`    2. Run locally (needs a provider key, e.g. OPENAI_API_KEY): ${chalk.cyan("evalguard eval:local " + opts.output)}`);
      console.log(`    3. Or in the cloud: ${chalk.cyan("evalguard eval --project <id> " + opts.output)}`);
      console.log();
      console.log(chalk.dim("  Getting started: https://evalguard.ai/quickstart"));
    });
}
