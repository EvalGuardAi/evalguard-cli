/**
 * `evalguard import:giskard <file>` — Import a Giskard test-set (scenarios) and
 * convert it to an EvalGuard config.
 *
 * Giskard (Giskard-AI/giskard, "giskard-oss") is an OSS evals + red-teaming +
 * test-generation framework for agentic systems. A generated or hand-authored
 * test-set is a **JSONL file of `Scenario` objects** (one JSON object per line
 * — e.g. giskard-scan's `scenarios/*.jsonl`, or a HuggingFace scenarios set).
 * Each `Scenario` has `name`, optional `category`/`tags`/`multiple_runs`, and a
 * `steps[]` list; each step has `interacts[]` (whose `inputs` is a generator —
 * `{kind:"llm_generator", prompt | prompt_path, ...}`) and `checks[]` (the
 * assertions — `conformity` rules, `equals`/comparison, `semantic_similarity`,
 * …). This command is the migration path for customers moving their Giskard
 * test-sets into EvalGuard.
 *
 * Accepted export shapes (clean-room — built from Giskard's PUBLIC `Scenario`
 * serialization, no Giskard code is used):
 *   (a) A JSONL file — one `Scenario` object per line (giskard's native
 *       test-set on disk, e.g. `prompt_injection.jsonl`).
 *   (b) A bare JSON array `[Scenario, …]`.
 *   (c) `{ scenarios: [...] }` / `{ tests: [...] }` / `{ data: [...] }` envelopes.
 *   (d) A single `Scenario` object `{ name?, steps: [...] }`.
 *
 * Giskard *checks* are Python objects (conformity judges, comparison operators,
 * semantic-similarity graders) — they don't carry runnable EvalGuard scorers, so
 * we do NOT invent scorer mappings for them. When a scenario's checks yield a
 * reference expectation (a `conformity` rule, an `equals` expected value, or a
 * `semantic_similarity` reference) we set the case's `expected` and attach a
 * single `equals` default scorer so the converted config is immediately
 * runnable, and the "Next steps" block points the user at `llm-grader`
 * (conformity/judge checks) / `semantic-similarity` and custom scorers.
 *
 * Pure-function design so every step is unit-testable. The CLI action is a
 * thin shell that reads → calls converter → writes file + summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Secret stripping ────────────────────────────────────────────────
// A Giskard scenario's generator `inputs`, `metadata`, or `annotations` can
// carry a captured api key (e.g. an llm_generator's model config logged
// alongside the scenario). We never want one in a checked-in
// evalguard.config.json, so we recursively strip secret-ish keys from
// EVERYTHING we write. Exact-key matches (case-insensitive) plus a conservative
// regex that catches `*_api_key` / `*_secret` / `access_token` style keys
// without false-positiving on `total_tokens` / `token_count`. (Same policy as
// import:deepeval / import:braintrust.)

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
  "giskard_api_key",
  "giskard_hub_token",
  "hub_api_key",
  "hub_token",
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

// ─── Scenario field extraction ───────────────────────────────────────

interface GiskardInteract {
  kind?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  metadata?: unknown;
  [extra: string]: unknown;
}
interface GiskardStep {
  interacts?: unknown;
  checks?: unknown;
  [extra: string]: unknown;
}
interface GiskardScenario {
  name?: unknown;
  category?: unknown;
  tags?: unknown;
  multiple_runs?: unknown;
  annotations?: unknown;
  steps?: unknown;
  [extra: string]: unknown;
}

/**
 * Extract the concrete input a scenario evaluates. Giskard scenarios don't hold
 * a literal input — the `interacts[].inputs` is a *generator* spec (usually
 * `{kind:"llm_generator", prompt | prompt_path, ...}`). We prefer an inline
 * `prompt` template (directly runnable as EvalGuard's `{{input}}`), fall back to
 * a `prompt_path` reference (flagged so the user knows to resolve it), and
 * finally to the raw inputs value when it's a plain string/scalar.
 */
export function extractScenarioInput(
  scenario: GiskardScenario,
): { value: unknown; kind: "prompt" | "prompt_path" | "raw" } | undefined {
  const steps = Array.isArray(scenario.steps) ? (scenario.steps as GiskardStep[]) : [];
  let promptPath: string | undefined;
  let rawFallback: unknown;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const interacts = Array.isArray(step.interacts) ? (step.interacts as GiskardInteract[]) : [];
    for (const it of interacts) {
      if (!it || typeof it !== "object") continue;
      const inputs = it.inputs;
      if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
        const g = inputs as Record<string, unknown>;
        // An inline generator prompt is directly runnable — highest priority.
        if (typeof g.prompt === "string" && g.prompt.length > 0) {
          return { value: g.prompt, kind: "prompt" };
        }
        if (typeof g.prompt_path === "string" && g.prompt_path.length > 0) {
          if (promptPath === undefined) promptPath = g.prompt_path;
        } else if (rawFallback === undefined) {
          // A literal dict input (not a prompt/prompt_path generator) — preserve
          // the whole object as vars (secrets are stripped downstream).
          rawFallback = inputs;
        }
      } else if (rawFallback === undefined && inputs !== undefined && inputs !== null) {
        // Non-object inputs (a literal string / value) — usable directly.
        rawFallback = inputs;
      }
    }
  }
  if (promptPath !== undefined) return { value: promptPath, kind: "prompt_path" };
  if (rawFallback !== undefined) return { value: rawFallback, kind: "raw" };
  return undefined;
}

interface GiskardCheck {
  kind?: unknown;
  rule?: unknown;
  expected?: unknown;
  expected_value?: unknown;
  value?: unknown;
  reference_text?: unknown;
  reference?: unknown;
  [extra: string]: unknown;
}

/** Flatten every check across all of a scenario's steps. */
export function extractChecks(scenario: GiskardScenario): GiskardCheck[] {
  const steps = Array.isArray(scenario.steps) ? (scenario.steps as GiskardStep[]) : [];
  const checks: GiskardCheck[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const stepChecks = Array.isArray(step.checks) ? (step.checks as GiskardCheck[]) : [];
    for (const c of stepChecks) {
      if (c && typeof c === "object" && !Array.isArray(c)) checks.push(c);
    }
  }
  return checks;
}

/**
 * Derive a reference `expected` string from a scenario's checks. Priority
 * (most-concrete first):
 *   1. a comparison/`equals` check's concrete value (`expected`/`expected_value`/`value`)
 *   2. a `semantic_similarity` check's `reference_text` / `reference`
 *   3. a `conformity` check's natural-language `rule` (the behavioral expectation)
 * Returns the value + which check kind supplied it (for the summary/next-steps).
 */
export function extractExpected(
  checks: GiskardCheck[],
): { value: string; fromKind: string } | undefined {
  const kindOf = (c: GiskardCheck): string =>
    typeof c.kind === "string" ? c.kind.toLowerCase() : "";
  const asStr = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "string") return v.length > 0 ? v : undefined;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  };

  // 1. Concrete comparison / equals value.
  for (const c of checks) {
    const k = kindOf(c);
    if (k === "equals" || k === "is_equal" || k === "exact_match" || k.includes("equal")) {
      const v = asStr(c.expected ?? c.expected_value ?? c.value);
      if (v !== undefined) return { value: v, fromKind: c.kind as string };
    }
  }
  // 2. Semantic-similarity reference text.
  for (const c of checks) {
    if (kindOf(c) === "semantic_similarity") {
      const v = asStr(c.reference_text ?? c.reference);
      if (v !== undefined) return { value: v, fromKind: c.kind as string };
    }
  }
  // 3. Conformity rule (Giskard's signature judge check).
  for (const c of checks) {
    if (kindOf(c) === "conformity") {
      const v = asStr(c.rule);
      if (v !== undefined) return { value: v, fromKind: c.kind as string };
    }
  }
  return undefined;
}

// ─── Full conversion ─────────────────────────────────────────────────

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

export interface GiskardConversionResult {
  config: {
    name: string;
    description?: string;
    prompt: string;
    cases: Record<string, unknown>[];
    defaultScorers?: EvalGuardScorer[];
  };
  /** Number of scenario records found in the export. */
  recordCount: number;
  /** Number of cases written (== scenarios that had an extractable input). */
  caseCount: number;
  /** Cases that carried a reference expectation (→ `expected`). */
  withReferenceCount: number;
  /** Cases whose input was a `prompt_path` reference (needs resolving). */
  withPromptPathCount: number;
  /** Distinct check kinds seen across all scenarios (e.g. conformity, equals). */
  checkKinds: string[];
  /** Distinct secret-ish keys stripped from inputs/checks/metadata. */
  strippedSecretKeys: string[];
  /** True when a default `equals` scorer was injected (dataset had references). */
  defaultScorerInjected: boolean;
}

/**
 * The default scorer attached when a Giskard test-set yields reference
 * expectations. `equals` is the honest, keyless baseline (output vs `expected`);
 * the user is told to swap it for the scorer matching their check's intent —
 * `llm-grader` for a `conformity` rule / judge, `semantic-similarity` for a
 * `semantic_similarity` check.
 */
export const DEFAULT_REFERENCE_SCORER = "equals";

/**
 * The scaffold prompt written into the converted config. A Giskard test-set's
 * input is a generator template (or `prompt_path`) with no fixed prompt of its
 * own, so we emit EvalGuard's idiomatic `{{input}}` placeholder (which
 * `validate` expects and `eval:local` / `gate` interpolate from each case's
 * `vars`). The user is told in "Next steps" to replace it with their real
 * prompt template.
 */
export const DEFAULT_PROMPT = "{{input}}";

/**
 * Convert a parsed Giskard test-set export into an EvalGuard config.
 * Pure — no I/O, no console — so it can be unit-tested in isolation.
 */
export function convertGiskardDataset(source: unknown): GiskardConversionResult {
  const records = extractRecords(source);
  const removedSecretKeys = new Set<string>();
  const checkKindSet = new Set<string>();

  const cases: Record<string, unknown>[] = [];
  let withReferenceCount = 0;
  let withPromptPathCount = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      // A non-object record (string / number / null) has no scenario to map —
      // skip rather than writing a bogus empty case.
      continue;
    }
    const scenario = rec as GiskardScenario;

    const input = extractScenarioInput(scenario);
    if (input === undefined) {
      // A scenario with no derivable input can't become a runnable case.
      continue;
    }
    if (input.kind === "prompt_path") withPromptPathCount++;

    const vars: Record<string, unknown> = {};
    const strippedInput = stripSecrets(input.value, removedSecretKeys);
    if (strippedInput && typeof strippedInput === "object" && !Array.isArray(strippedInput)) {
      Object.assign(vars, strippedInput as Record<string, unknown>);
    } else {
      vars.input = strippedInput;
    }

    // Preserve Giskard scenario metadata so nothing is silently dropped.
    if (typeof scenario.name === "string" && scenario.name.length > 0) {
      vars.giskard_scenario = scenario.name;
    }
    if (typeof scenario.category === "string" && scenario.category.length > 0) {
      vars.category = scenario.category;
    }
    if (Array.isArray(scenario.tags) && scenario.tags.length > 0) {
      vars.tags = stripSecrets(scenario.tags, removedSecretKeys);
    }
    if (input.kind === "prompt_path") {
      vars.giskard_prompt_path = input.value;
    }

    const checks = extractChecks(scenario);
    const checkKinds = checks
      .map((c) => (typeof c.kind === "string" ? c.kind : undefined))
      .filter((k): k is string => !!k);
    for (const k of checkKinds) checkKindSet.add(k);
    if (checkKinds.length > 0) {
      vars.giskard_checks = [...new Set(checkKinds)];
    }

    const c: Record<string, unknown> = { vars };

    const expected = extractExpected(checks);
    if (expected !== undefined) {
      const strippedExpected = stripSecrets(expected.value, removedSecretKeys);
      if (typeof strippedExpected === "string" && strippedExpected.length > 0) {
        c.expected = strippedExpected;
        withReferenceCount++;
      }
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

  const config: GiskardConversionResult["config"] = {
    name:
      typeof datasetName === "string" && datasetName.length > 0
        ? datasetName
        : "Imported from Giskard",
    prompt: DEFAULT_PROMPT,
    cases,
  };
  if (typeof datasetDescription === "string" && datasetDescription.length > 0) {
    config.description = datasetDescription;
  }

  // Attach a runnable default scorer ONLY when reference values exist — that is
  // what makes the config valid + runnable (`validate`/`gate` require at least
  // one scorer). We do NOT synthesize scorers from Giskard checks (Python
  // objects); those are surfaced as a next step instead.
  const defaultScorerInjected = withReferenceCount > 0;
  if (defaultScorerInjected) {
    config.defaultScorers = [{ scorer: DEFAULT_REFERENCE_SCORER }];
  }

  return {
    config,
    recordCount: records.length,
    caseCount: cases.length,
    withReferenceCount,
    withPromptPathCount,
    checkKinds: [...checkKindSet].sort(),
    strippedSecretKeys: [...removedSecretKeys].sort(),
    defaultScorerInjected,
  };
}

function extractRecords(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    const obj = source as {
      scenarios?: unknown[];
      tests?: unknown[];
      data?: unknown[];
      steps?: unknown;
    };
    if (Array.isArray(obj.scenarios)) return obj.scenarios;
    if (Array.isArray(obj.tests)) return obj.tests;
    if (Array.isArray(obj.data)) return obj.data;
    // A single Scenario object (has `steps`) — treat as a one-record test-set.
    if (obj.steps !== undefined) return [source];
    return [];
  }
  return [];
}

// ─── JSON / JSONL loader ─────────────────────────────────────────────

/**
 * Load a Giskard test-set from disk. Giskard's native on-disk format is
 * **JSONL** (one `Scenario` per line — giskard-scan writes these, and
 * HuggingFace scenario sets use the same shape), but a hand-exported test-set
 * may be a single JSON array/object. We try whole-file JSON first (covers array
 * / object / single scenario), then fall back to line-delimited JSONL, parsing
 * each non-empty line as one Scenario. Exported so the loader's contract can be
 * unit-tested directly.
 *
 * Note: JSONL is parsed line-by-line off the RAW text, so non-schema keys Giskard
 * itself drops on model load (e.g. `category`) survive into our cases.
 */
export function loadGiskardFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");

  // 1. Whole-file JSON (array, envelope object, or single scenario).
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    // Only attempt whole-file JSON when it *looks* like a single document;
    // a JSONL file also starts with "{" per line, so guard by newline count.
    try {
      const parsed = JSON.parse(content) as unknown;
      // A JSONL file where the FIRST line happens to be valid JSON would throw
      // on the second line, so a clean whole-file parse means it's real JSON.
      return parsed;
    } catch {
      // fall through to JSONL
    }
  }

  // 2. JSONL — one Scenario object per line.
  const lines = content.split(/\r?\n/);
  const scenarios: unknown[] = [];
  const parseErrors: string[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.length === 0) return;
    try {
      scenarios.push(JSON.parse(t));
    } catch (err) {
      parseErrors.push(`line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (scenarios.length === 0) {
    const hint =
      "Giskard test-sets are JSONL (one Scenario per line) or a JSON array of scenarios. Export from giskard-scan/giskard-checks or your test-set directory.";
    if (parseErrors.length > 0) {
      throw new Error(
        `Invalid Giskard export (not valid JSON or JSONL). First error: ${parseErrors[0]}. ${hint}`,
      );
    }
    throw new Error(`Empty or unparseable Giskard export. ${hint}`);
  }

  return { scenarios };
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportGiskard(program: Command): void {
  program
    .command("import:giskard")
    .description("Migrate a Giskard test-set (scenarios) to an EvalGuard config")
    .argument("<file>", "Path to a Giskard test-set export (JSONL or JSON)")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action((file: string, opts: { output: string; dryRun?: boolean }) => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — Giskard Import"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

      let source: unknown;
      try {
        source = loadGiskardFile(filePath);
      } catch (err) {
        console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = convertGiskardDataset(source);

      // ── Summary ──
      console.log();
      console.log(chalk.bold("  Conversion Summary:"));
      console.log(`    ${chalk.green("✓")} ${result.recordCount} scenario(s) read`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} case(s) converted`);
      console.log(`    ${chalk.green("✓")} ${result.withReferenceCount} case(s) with a reference expectation (→ expected)`);
      if (result.withPromptPathCount > 0) {
        console.log(
          `    ${chalk.yellow("!")} ${result.withPromptPathCount} case(s) use a Giskard ${chalk.cyan("prompt_path")} reference — resolve it into an inline prompt/vars`,
        );
      }
      if (result.checkKinds.length > 0) {
        console.log(`    ${chalk.green("✓")} check kinds preserved in vars: ${chalk.dim(result.checkKinds.join(", "))}`);
      }
      if (result.strippedSecretKeys.length > 0) {
        console.log(
          `    ${chalk.green("✓")} stripped ${result.strippedSecretKeys.length} secret-ish key(s): ${chalk.dim(result.strippedSecretKeys.join(", "))}`,
        );
      }
      if (result.defaultScorerInjected) {
        console.log(
          `    ${chalk.green("✓")} added default scorer ${chalk.bold(DEFAULT_REFERENCE_SCORER)} (test-set has reference expectations)`,
        );
      }

      // ── Next steps note (mirrors deepeval's unmapped-suggestion block) ──
      console.log();
      console.log(chalk.yellow("  Giskard checks are Python objects — not migrated automatically:"));
      console.log(
        `    ${chalk.yellow("!")} Re-create each Giskard check (conformity / comparison / semantic_similarity / judges) as an EvalGuard scorer ${chalk.dim("→")} ${chalk.cyan("/docs/scorers/custom")}`,
      );
      console.log(
        `    ${chalk.yellow("!")} A ${chalk.cyan("conformity")} rule maps to ${chalk.cyan("llm-grader")}; a ${chalk.cyan("semantic_similarity")} check maps to ${chalk.cyan("semantic-similarity")}`,
      );
      if (result.defaultScorerInjected) {
        console.log(
          `    ${chalk.yellow("!")} Review the injected ${chalk.bold(DEFAULT_REFERENCE_SCORER)} scorer — swap for ${chalk.cyan("llm-grader")} / ${chalk.cyan("semantic-similarity")} if exact match is too strict`,
        );
      } else {
        console.log(
          `    ${chalk.yellow("!")} No reference expectations found — add a ${chalk.cyan("scorers")}/${chalk.cyan("defaultScorers")} block before running`,
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
        `    1. Review ${chalk.cyan(opts.output)} — set your ${chalk.cyan("prompt")} template + re-create your Giskard checks as scorers`,
      );
      console.log(`    2. Run locally (no API key): ${chalk.cyan("npx @evalguard/cli eval:local " + opts.output)}`);
      console.log(`       Or gate a build (keyless): ${chalk.cyan("npx @evalguard/cli gate " + opts.output + " --provider echo")}`);
      console.log(`       Or run in the cloud:      ${chalk.cyan("npx @evalguard/cli eval --project <id> " + opts.output)}`);
      console.log(`    3. Try: ${chalk.cyan("npx @evalguard/cli scan")} for 300+ red team attacks`);
      console.log();
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/migrate-from-giskard"));
      console.log();
    });
}
