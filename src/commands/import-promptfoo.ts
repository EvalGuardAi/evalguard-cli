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
// Every promptfoo assertion type we've seen across their docs + sample
// configs. When extending: if the new assertion has a 1:1 EvalGuard
// scorer, map to it. If it's promptfoo-only (e.g. `python` arbitrary
// script), leave OUT of the map so the unmapped-suggestion table can
// recommend the next-best EvalGuard equivalent.

export const ASSERTION_MAP: Record<string, string> = {
  contains: "contains",
  "not-contains": "not-contains",
  icontains: "icontains",
  "contains-any": "contains-any",
  "contains-all": "contains-all",
  equals: "equals",
  "starts-with": "starts-with",
  "ends-with": "ends-with",
  regex: "regex",
  "is-json": "json-valid",
  "is-valid-openai-function-call": "function-call-valid",
  "llm-rubric": "llm-grader",
  "model-graded-closedqa": "llm-grader",
  "model-graded-fact": "factuality",
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
};

// Recommendations for promptfoo assertion types that DON'T have a clean
// 1:1 mapping. The CLI prints these in the unmapped-summary block so the
// user has a clear next step instead of "you'll have to rewrite this".
export const ASSERTION_SUGGESTIONS: Record<string, string> = {
  // Arbitrary code execution — no direct EvalGuard equivalent. Closest
  // thing is to write a custom scorer in your evalguard.config.json.
  javascript: "Custom scorer required — see /docs/scorers/custom",
  python: "Custom scorer required — see /docs/scorers/custom",
  webhook: "Use the EvalGuard `webhook` post-eval action instead",
  rouge: "Use `semantic-similarity` (closer match) or `embedding-similarity`",
  bleu: "Use `semantic-similarity`",
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

  // ── Default assertions ──
  const defaultTest = source.defaultTest as Record<string, unknown> | undefined;
  const defaultScorers: EvalGuardScorer[] = [];
  if (defaultTest?.assert) {
    for (const a of defaultTest.assert as Record<string, unknown>[]) {
      const mapped = mapAssertion(a);
      if (mapped) defaultScorers.push(mapped);
    }
  }

  // ── Test cases ──
  const rawTests = (source.tests ?? []) as Record<string, unknown>[];
  const cases = rawTests.map((test) => {
    const testCase: Record<string, unknown> = {};
    if (test.vars) testCase.vars = test.vars;
    if (test.description) testCase.description = test.description;

    const assertions = test.assert as Record<string, unknown>[] | undefined;
    if (assertions) {
      testCase.scorers = assertions
        .map(mapAssertion)
        .filter((s): s is EvalGuardScorer => s !== null);
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
    const baseType = type.startsWith("not-") ? type.replace(/^not-/, "") : type;
    if (!ASSERTION_MAP[type] && !ASSERTION_MAP[baseType]) {
      unmappedSet.add(type);
    }
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

async function loadYaml(filePath: string): Promise<Record<string, unknown>> {
  const content = fs.readFileSync(filePath, "utf-8");

  // Try JSON first (promptfooconfig.json is a common alternative).
  try {
    return JSON.parse(content);
  } catch {
    // Dynamically import the YAML parser. Falls back to throwing a
    // helpful error if the `yaml` package isn't installed.
    try {
      const yamlMod = await import("yaml");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parse = (yamlMod as any).parse ?? (yamlMod as any).default?.parse;
      if (parse) return parse(content) as Record<string, unknown>;
    } catch {
      // Fall through
    }
    throw new Error(
      "YAML parsing requires the 'yaml' package. Install it with: npm install yaml\n" +
      "Alternatively, convert your promptfooconfig.yaml to JSON first.",
    );
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

      // ── Write output ──
      const outputPath = path.resolve(opts.output);
      fs.writeFileSync(outputPath, JSON.stringify(result.config, null, 2), "utf-8");

      console.log();
      console.log(`  ${chalk.green("✓")} Written to ${chalk.cyan(opts.output)}`);
      console.log();
      console.log(chalk.bold("  Next steps:"));
      console.log(`    1. Review ${chalk.cyan(opts.output)}`);
      console.log(`    2. Run: ${chalk.cyan("npx evalguard eval " + opts.output)}`);
      console.log(`    3. Try: ${chalk.cyan("npx evalguard scan")} for 249+ red team attacks`);
      console.log();
      console.log(chalk.dim("  Migration guide: https://evalguard.ai/docs/migrating-from-promptfoo"));
      console.log();
    });
}
