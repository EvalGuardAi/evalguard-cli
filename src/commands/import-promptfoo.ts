/**
 * `evalguard import:promptfoo <file>` — import a Promptfoo config and convert
 * it to an EvalGuard config.
 *
 * Pure-function design: every step of the conversion is a named export
 * so it can be unit-tested in isolation. The CLI action is a thin
 * shell that reads file → calls `convertPromptfooConfig` → writes
 * file + prints summary.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

// ─── Assertion type mapping ───
//
// KEY   = a Promptfoo assertion `type`.
// VALUE = an EvalGuard scorer key.
//
// When extending: if the new assertion has a 1:1 EvalGuard scorer, map to it.
// If it's promptfoo-only (e.g. `python` arbitrary script), leave OUT of the map
// so the unmapped-suggestion table can recommend the next-best equivalent.
//
// ── BOTH SIDES ARE CHECKED AGAINST THE OTHER PROJECT'S SOURCE (2026-08-10) ──
//
// This table used to be "every promptfoo assertion type we've seen across their
// docs + sample configs". Seen-in-docs is not a vocabulary: four of the 27 keys
// were strings Promptfoo has never accepted, and two of the values named a
// scorer EvalGuard does not have. Neither side crashes — a dead key is simply
// never looked up, and a bad value is written into the generated config and only
// surfaces later as `eval:local`'s "Unknown scorers" — so the whole class was
// invisible. Re-derived mechanically:
//
//   KEYS   vs `BaseAssertionTypesSchema` (66 types) + the generated `not-<base>`
//          forms + `SpecialAssertionTypes`, in promptfoo's src/types/index.ts
//          @ db03327 (v0.121.17).
//   VALUES vs `Object.keys(BUILT_IN_SCORERS)` (245) in the COMPILED
//          packages/core/dist — the artifact that actually resolves at runtime.
//
// Fixed here:
//   `model-graded-fact` → `model-graded-factuality`  their enum has
//        `factuality`, `model-graded-factuality` and `model-graded-closedqa`;
//        never `model-graded-fact`. Both of the first two hit `handleFactuality`
//        on their side, so both map to our `factuality`.
//   `rouge`            → `rouge-n`                   they only ever named it
//        `rouge-n`. The old key shadowed nothing and the real type fell through.
//   `regex`            → value was "regex"           the registry key is
//        `regex-match` (`regex` is ABSENT from the 245). This one hit every user
//        who wrote the single most common promptfoo assertion there is.
//   `is-valid-openai-function-call` → value was "function-call-valid"
//        the registry key is `is-valid-function-call`. Promptfoo routes its own
//        `is-valid-function-call` to the same handler, so that type is mapped
//        here too rather than being silently dropped.
//
// DELIBERATELY NOT promptfoo types, and not a defect — do not "clean up":
// `ends-with`, `toxicity` and `bias` are identity pass-throughs to real
// EvalGuard scorers. Promptfoo documents that it has no `ends-with` assertion
// (use `regex` with a `$` anchor), and its `toxicity`/`bias` are RED-TEAM PLUGIN
// ids, not assertion types. They are kept so a hand-written or already-migrated
// EvalGuard config carrying those names still resolves; removing them would make
// `convertPromptfooConfig` drop the assertion instead.
//
// COVERAGE, stated rather than implied: 29 of Promptfoo's 66 base types are
// named here or in ASSERTION_SUGGESTIONS. The other 37 are dropped on import and
// reported in `unmappedAssertions` — that is a real gap, not a claim of parity.
// (It read 26 before the repair above: two of the keys covered nothing because
// they were not types. The gate for this number is in the importer's tests.)

export const ASSERTION_MAP: Record<string, string> = {
  contains: "contains",
  "not-contains": "not-contains",
  icontains: "icontains",
  "contains-any": "contains-any",
  "contains-all": "contains-all",
  equals: "equals",
  "starts-with": "starts-with",
  "ends-with": "ends-with",
  regex: "regex-match",
  "is-json": "json-valid",
  "is-valid-function-call": "is-valid-function-call",
  "is-valid-openai-function-call": "is-valid-function-call",
  "llm-rubric": "llm-grader",
  "model-graded-closedqa": "llm-grader",
  "model-graded-factuality": "factuality",
  factuality: "factuality",
  "answer-relevance": "answer-relevance",
  "context-faithfulness": "context-faithfulness",
  "context-relevance": "context-relevance",
  similar: "semantic-similarity",
  cost: "cost",
  latency: "latency",
  toxicity: "toxicity",
  bias: "bias",
  "is-refusal": "is-refusal",
  // Reference-overlap + external-webhook metrics that DO have a 1:1 built-in
  // scorer in @evalguard/core — verified against the registry keys in
  // packages/core/src/scorers/registry.ts (`bleu`, `rouge-n`, `webhook`). Map
  // them so a customer's `bleu`/`rouge-n`/`webhook` assertion migrates instead
  // of being mis-flagged as "no EvalGuard equivalent". (promptfoo's `webhook`
  // assertion carries the URL in `value`; the EvalGuard `webhook` scorer reads
  // it from `options.url`, so the migrated entry keeps the value for the user
  // to move — but the scorer itself genuinely exists.)
  bleu: "bleu",
  "rouge-n": "rouge-n",
  webhook: "webhook",
};

// Recommendations for promptfoo assertion types that DON'T have a clean
// 1:1 mapping. The CLI prints these in the unmapped-summary block so the
// user has a clear next step instead of "you'll have to rewrite this".
export const ASSERTION_SUGGESTIONS: Record<string, string> = {
  // Arbitrary code execution — no direct EvalGuard equivalent. Closest
  // thing is to write a custom scorer in your evalguard.config.json.
  javascript: "Custom scorer required — see /docs/scorers/custom",
  python: "Custom scorer required — see /docs/scorers/custom",
  "perplexity-score": "EvalGuard scores via deep-grader rubric instead — see `judge`",
  classifier: "Use one of the deep-grader scorers (e.g. `bias`, `toxicity`)",
  moderation: "Use `toxicity` + `pii_leak` deep graders combined",
};

// ─── Provider mapping ───

export interface EvalGuardProvider {
  provider: string;
  model: string;
  config?: Record<string, unknown>;
}

/**
 * Convert a promptfoo provider spec to EvalGuard form.
 *
 * Promptfoo accepts a provider as either:
 *   - A string `"openai:gpt-4o"` (provider:model colon-separated)
 *   - An object `{ id: "openai:gpt-4o", config: { ... } }`
 *
 * We normalise both into `{ provider, model, config? }`. The `config`
 * field has `apiKey` stripped because EvalGuard reads keys from the
 * environment (or BYOK store), never from a checked-in config.
 */
export function mapProvider(raw: string | Record<string, unknown>): EvalGuardProvider {
  if (typeof raw === "string") {
    const parts = raw.split(":");
    if (parts.length >= 2) {
      // `azureopenai` is promptfoo's name; EvalGuard calls it `azure`.
      const providerName = parts[0] === "azureopenai" ? "azure" : parts[0];
      const modelName = parts.slice(1).join(":");
      return { provider: providerName, model: modelName };
    }
    return { provider: raw, model: raw };
  }

  // Object format.
  const id = (raw.id ?? raw.label ?? "") as string;
  const mapped = mapProvider(id);
  const config = raw.config as Record<string, unknown> | undefined;
  if (config) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      if (k === "apiKey" || k === "api_key") continue;
      rest[k] = v;
    }
    if (Object.keys(rest).length > 0) {
      mapped.config = rest;
    }
  }
  return mapped;
}

// ─── Assertion mapping ───

export interface EvalGuardScorer {
  scorer: string;
  value?: unknown;
  threshold?: number;
}

/**
 * Convert a single promptfoo assertion to an EvalGuard scorer.
 * Returns null when the input has no `type` field (malformed config).
 *
 * If the assertion type is unknown to us, we pass it through verbatim
 * (with a `scorer:` field that won't match anything in EvalGuard's
 * registry). The caller is responsible for surfacing those via the
 * `unmappedAssertions` field on the conversion result.
 */
/**
 * Whether a promptfoo assertion `type` resolves to a real EvalGuard scorer via
 * {@link ASSERTION_MAP} — directly, or as a `not-<known>` negation of one.
 *
 * Unknown types (`javascript`/`python`/…) return false: they're surfaced in the
 * unmapped report with a suggestion rather than written as a bogus `scorer:` the
 * registry has no entry for (which would later trip `validate`/`eval:local`'s
 * "Unknown scorers"), and they must NOT be counted in the "mapped" total.
 */
export function isMappedAssertion(type: string): boolean {
  if (ASSERTION_MAP[type]) return true;
  const base = type.startsWith("not-") ? type.replace(/^not-/, "") : type;
  return Boolean(ASSERTION_MAP[base]);
}

export function mapAssertion(assertion: Record<string, unknown>): EvalGuardScorer | null {
  const type = assertion.type as string;
  if (!type) return null;

  // Handle `not-` prefix on a known type.
  const isNegated = type.startsWith("not-") && !ASSERTION_MAP[type];
  const baseType = isNegated ? type.replace(/^not-/, "") : type;
  const mapped = ASSERTION_MAP[type] ?? ASSERTION_MAP[baseType];

  if (!mapped) {
    // Unknown type — pass through verbatim so the caller can flag it.
    return { scorer: type, value: assertion.value, threshold: assertion.threshold as number | undefined };
  }

  const scorer: EvalGuardScorer = { scorer: isNegated ? `not-${mapped}` : mapped };
  if (assertion.value !== undefined) scorer.value = assertion.value;
  if (assertion.threshold !== undefined) scorer.threshold = assertion.threshold as number;
  return scorer;
}

// ─── Full conversion ─────────────────────────────────────────────────

export interface ConversionResult {
  /** The EvalGuard config that should be written to disk. */
  config: {
    name: string;
    providers: EvalGuardProvider[];
    prompts: string[];
    defaultScorers?: EvalGuardScorer[];
    cases?: Record<string, unknown>[];
  };
  /** Number of test cases converted. */
  caseCount: number;
  /** Number of default scorers mapped. */
  defaultScorerCount: number;
  /** Assertion types in the source that had no mapping. Deduped. */
  unmappedAssertions: string[];
  /** Provider strings that couldn't be parsed (zero in v1). */
  unmappedProviders: string[];
}

/**
 * Convert a parsed promptfoo config object into an EvalGuard config.
 * This is the pure-function heart of the importer — no I/O, no
 * console writes — so it can be tested in isolation.
 */
export function convertPromptfooConfig(
  source: Record<string, unknown>,
): ConversionResult {
  // ── Providers ──
  const rawProviders = (source.providers ?? []) as (string | Record<string, unknown>)[];
  const providers = rawProviders.map(mapProvider);

  // ── Prompts ──
  const prompts = (source.prompts ?? []) as string[];

  // ── Default assertions ── only truly-mapped types become scorers. Unknown
  // types (javascript/python/…) are collected in `unmappedAssertions` below with
  // a suggestion instead of being written as a bogus `scorer:` name (which would
  // later trip "Unknown scorers") — and so they don't inflate the mapped count.
  const defaultTest = source.defaultTest as Record<string, unknown> | undefined;
  const defaultScorers: EvalGuardScorer[] = [];
  if (defaultTest?.assert) {
    for (const a of defaultTest.assert as Record<string, unknown>[]) {
      const type = a.type as string | undefined;
      if (!type || !isMappedAssertion(type)) continue;
      const mapped = mapAssertion(a);
      if (mapped) defaultScorers.push(mapped);
    }
  }

  // ── Test cases ── same rule per case: emit only mapped scorers; drop the
  // `scorers:` key entirely when a case has none that map.
  const rawTests = (source.tests ?? []) as Record<string, unknown>[];
  const cases = rawTests.map((test) => {
    const testCase: Record<string, unknown> = {};
    if (test.vars) testCase.vars = test.vars;
    if (test.description) testCase.description = test.description;

    const assertions = test.assert as Record<string, unknown>[] | undefined;
    if (assertions) {
      const mappedScorers = assertions
        .filter((a) => typeof a.type === "string" && isMappedAssertion(a.type as string))
        .map(mapAssertion)
        .filter((s): s is EvalGuardScorer => s !== null);
      if (mappedScorers.length > 0) testCase.scorers = mappedScorers;
    }
    return testCase;
  });

  // ── Unmapped collection ──
  const unmappedSet = new Set<string>();
  const allAssertions = [
    ...((defaultTest?.assert ?? []) as Record<string, unknown>[]),
    ...rawTests.flatMap((t) => (t.assert ?? []) as Record<string, unknown>[]),
  ];
  for (const a of allAssertions) {
    const type = a.type as string | undefined;
    if (!type) continue;
    if (!isMappedAssertion(type)) unmappedSet.add(type);
  }

  const config: ConversionResult["config"] = {
    name: (source.description as string) ?? "Imported from Promptfoo",
    providers,
    prompts,
  };
  if (defaultScorers.length > 0) config.defaultScorers = defaultScorers;
  if (cases.length > 0) config.cases = cases;

  return {
    config,
    caseCount: cases.length,
    defaultScorerCount: defaultScorers.length,
    unmappedAssertions: [...unmappedSet].sort(),
    unmappedProviders: [],
  };
}

// ─── YAML parsing ────────────────────────────────────────────────────

type YamlParse = (s: string) => unknown;

/**
 * Load a promptfoo config from disk as JSON or YAML.
 *
 * The two failure modes are kept DISTINCT: only a genuinely-missing `yaml`
 * module produces the "install the 'yaml' package" hint. When `yaml` IS present
 * but the file is malformed, the real `YAMLParseError` (with line/column) is
 * surfaced — previously an inner catch swallowed it and every parse error was
 * misreported as "install the package" even though the package was installed.
 *
 * Exported so the loader's error contract can be unit-tested without the CLI's
 * IO/`process.exit` wrapper.
 */
export async function loadYaml(filePath: string): Promise<Record<string, unknown>> {
  const content = fs.readFileSync(filePath, "utf-8");

  // Try JSON first (promptfooconfig.json is a common alternative).
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Not JSON — parse as YAML below.
  }

  // Dynamically import the YAML parser. ONLY a missing module warrants the
  // install hint.
  const installHint =
    "YAML parsing requires the 'yaml' package. Install it with: npm install yaml\n" +
    "Alternatively, convert your promptfooconfig.yaml to JSON first.";
  let parse: YamlParse | undefined;
  try {
    const yamlMod = await import("yaml");
    parse =
      (yamlMod as { parse?: YamlParse }).parse ??
      (yamlMod as { default?: { parse?: YamlParse } }).default?.parse;
  } catch {
    throw new Error(installHint);
  }
  if (typeof parse !== "function") {
    throw new Error(installHint);
  }

  // `yaml` IS present — a throw here is a genuinely malformed file. Surface the
  // real parser error (line/column) instead of the install hint.
  try {
    return parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Main command ────────────────────────────────────────────────────

export function registerImportPromptfoo(program: Command): void {
  program
    .command("import:promptfoo")
    .description("Import a Promptfoo config and convert to EvalGuard format")
    .argument("<file>", "Path to promptfooconfig.yaml or JSON file")
    .option("-o, --output <path>", "Output file path", "evalguard.config.json")
    .option("--dry-run", "Print the converted config without writing to disk")
    .action(async (file: string, opts: { output: string; dryRun?: boolean }) => {
      const filePath = path.resolve(file);

      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — Promptfoo Import"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  Reading ${chalk.cyan(path.basename(filePath))}...`);

      let source: Record<string, unknown>;
      try {
        source = await loadYaml(filePath);
      } catch (err) {
        console.error(chalk.red(`  Failed to parse: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = convertPromptfooConfig(source);

      // ── Summary ──
      console.log();
      console.log(chalk.bold("  Conversion Summary:"));
      console.log(`    ${chalk.green("✓")} ${result.config.providers.length} provider(s) mapped`);
      console.log(`    ${chalk.green("✓")} ${result.config.prompts.length} prompt(s) preserved`);
      console.log(`    ${chalk.green("✓")} ${result.caseCount} test case(s) converted`);
      console.log(`    ${chalk.green("✓")} ${result.defaultScorerCount} default scorer(s) mapped`);

      if (result.unmappedAssertions.length > 0) {
        console.log();
        console.log(chalk.yellow(`  ${result.unmappedAssertions.length} assertion type(s) without a direct mapping:`));
        for (const type of result.unmappedAssertions) {
          const suggestion = ASSERTION_SUGGESTIONS[type];
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

      // ── Write output ── honor the extension: .yaml/.yml → YAML, else JSON.
      const outputPath = path.resolve(opts.output);
      let serialized: string;
      if (/\.ya?ml$/i.test(outputPath)) {
        const yamlMod = await import("yaml");
        const stringify =
          (yamlMod as { stringify?: (v: unknown) => string }).stringify ??
          (yamlMod as { default?: { stringify?: (v: unknown) => string } }).default?.stringify;
        if (!stringify) throw new Error("YAML serialization requires the 'yaml' package.");
        serialized = stringify(result.config);
      } else {
        serialized = JSON.stringify(result.config, null, 2);
      }
      fs.writeFileSync(outputPath, serialized, "utf-8");

      console.log();
      console.log(`  ${chalk.green("✓")} Written to ${chalk.cyan(opts.output)}`);
      console.log();
      console.log(chalk.bold("  Next steps:"));
      console.log(`    1. Review ${chalk.cyan(opts.output)}`);
      // Run LOCALLY by default: `eval:local` is the keyless local runner and
      // reads the converted providers/prompts/defaultScorers shape directly.
      // Plain `eval` is server-backed and fails keyless with "Could not resolve
      // a default project", so point the cloud path at `eval --project <id>`.
      console.log(`    2. Run locally (no API key): ${chalk.cyan("npx @evalguard/cli eval:local " + opts.output)}`);
      console.log(`       Or run in the cloud:     ${chalk.cyan("npx @evalguard/cli eval --project <id> " + opts.output)}`);
      console.log(`    3. Try: ${chalk.cyan("npx @evalguard/cli scan")} for 300+ red team attacks`);
      console.log();
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/docs/migrating-from-promptfoo"));
      console.log();
    });
}
