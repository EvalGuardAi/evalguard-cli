/**
 * `evalguard generate dataset` — Synthesize evaluation test cases from
 * a system prompt file or document, using 7 evolution strategies.
 *
 * `evalguard generate synthetic` — Template-based dataset generation with NO
 * LLM call: offline, zero cost, byte-reproducible from `--seed`. This is the
 * surface for the `SyntheticDataFactory` in packages/core/src/synthetic, which
 * shipped exported-but-uncalled until the 2026-08 thin-or-dead sweep.
 *
 * Usage:
 *   evalguard generate dataset --from <file> --count 50 --strategy reasoning,edge-case
 *   evalguard generate dataset --from prompt.txt --count 20 --format csv --output tests.csv
 *   evalguard generate synthetic --domain healthcare --type pii_test --count 25 --seed 7
 *   evalguard generate synthetic --list
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
import { makeCallLLM } from "../lib/call-llm.js";

/**
 * The difficulty levels `SyntheticDataConfig` declares
 * (`difficulty?: "easy" | "medium" | "hard"`, packages/core/src/synthetic/index.ts:11).
 * A type is erased at runtime, so the enum is restated here; every level in
 * this list is exercised end-to-end by `__tests__/generate-synthetic.test.ts`,
 * which also proves a value outside it is rejected.
 */
const SYNTHETIC_DIFFICULTIES = ["easy", "medium", "hard"] as const;
type SyntheticDifficulty = (typeof SYNTHETIC_DIFFICULTIES)[number];

/** Shape of the dataset returned by `SyntheticDataFactory.generate()`. */
export interface SyntheticCliDataset {
  id: string;
  items: Array<{
    id: string;
    input: string;
    expectedOutput?: string;
    category?: string;
    difficulty?: string;
    language?: string;
  }>;
  metadata: {
    generatedAt: string;
    domain: string;
    type: string;
    totalItems: number;
    languages: string[];
    qualityScore: number;
    /** Absent when running against a core build older than 2026-08. */
    groundTruthCoverage?: number;
  };
}

/**
 * Serialize a template-generated dataset. Pure — no fs, no process, no core
 * import — so it is unit-testable without a built `@evalguard/core`.
 */
export function serializeSyntheticDataset(
  dataset: SyntheticCliDataset,
  format: "json" | "csv",
): string {
  if (format === "csv") {
    return [
      "id,input,expectedOutput,category,difficulty,language",
      ...dataset.items.map((it) =>
        [
          csvEscape(it.id),
          csvEscape(it.input),
          csvEscape(it.expectedOutput ?? ""),
          csvEscape(it.category ?? ""),
          csvEscape(it.difficulty ?? ""),
          csvEscape(it.language ?? ""),
        ].join(","),
      ),
    ].join("\n");
  }
  return JSON.stringify(
    {
      datasetId: dataset.id,
      generatedAt: dataset.metadata.generatedAt,
      domain: dataset.metadata.domain,
      type: dataset.metadata.type,
      totalItems: dataset.metadata.totalItems,
      // Both are MEASURED over the emitted items (lexical-diversity % and
      // labelled-item %). Neither is a semantic-quality judgement.
      qualityScore: dataset.metadata.qualityScore,
      groundTruthCoverage: dataset.metadata.groundTruthCoverage,
      cases: dataset.items,
    },
    null,
    2,
  );
}

export function registerGenerateDataset(program: Command): void {
  // Find or create the "generate" parent command
  let gen = program.commands.find((c) => c.name() === "generate");
  if (!gen) {
    gen = program.command("generate").description("Generate synthetic test data");
  }

  // ─── generate synthetic ─── (offline, template-based, no LLM)
  gen
    .command("synthetic")
    .description(
      "Generate a template-based dataset offline (no LLM call, no API key, reproducible from --seed)",
    )
    .option("--domain <domain>", "Domain template pack (see --list)")
    .option("--type <type>", "Data type within the domain (see --list)")
    .option("-n, --count <n>", "Number of items to generate", "20")
    .option("--seed <n>", "Integer seed — same seed produces the same items")
    .option("--ground-truth", "Include reference answers where the templates ship them", false)
    .option("--difficulty <level>", "Tag items easy|medium|hard", "medium")
    .option("--format <fmt>", "Output format: json or csv", "json")
    .option("--output <file>", "Output file path (default: synthetic-<domain>-<type>.<format>)")
    .option("--list", "List available domains and types, then exit", false)
    .action(
      async (opts: {
        domain?: string;
        type?: string;
        count: string;
        seed?: string;
        groundTruth: boolean;
        difficulty: string;
        format: string;
        output?: string;
        list: boolean;
      }) => {
        // Structural cast through `unknown`: `templateCounts` only exists on
        // core builds from 2026-08 onward, so we call it optionally rather than
        // binding to the published .d.ts (which may lag the workspace source).
        const { syntheticDataFactory } = (await import(
          "@evalguard/core"
        )) as unknown as {
          syntheticDataFactory: {
            generate: (c: Record<string, unknown>) => SyntheticCliDataset;
            listDomains: () => string[];
            listTypes: (d: string) => string[];
            templateCounts?: (
              d: string,
              t: string,
            ) => { inputCount: number; outputCount: number };
          };
        };

        const domains = syntheticDataFactory.listDomains();

        if (opts.list) {
          console.log();
          console.log(chalk.bold("  Offline synthetic template packs"));
          console.log();
          for (const d of domains) {
            const types = syntheticDataFactory.listTypes(d);
            console.log(`  ${chalk.cyan(d)}`);
            for (const t of types) {
              const counts = syntheticDataFactory.templateCounts?.(d, t);
              const detail = counts
                ? chalk.dim(
                    `${counts.inputCount} templates` +
                      (counts.outputCount > 0 ? `, ${counts.outputCount} with answers` : ", no answers"),
                  )
                : "";
              console.log(`    ${chalk.white(t.padEnd(16))}${detail}`);
            }
          }
          console.log();
          console.log(
            chalk.dim(
              "  Drawing more items than a pack has templates repeats inputs; qualityScore reports the resulting distinct-input %.",
            ),
          );
          console.log();
          return;
        }

        if (!opts.domain || !opts.type) {
          console.error(
            chalk.red("  --domain and --type are required (run with --list to see the packs)"),
          );
          process.exit(1);
        }
        if (!domains.includes(opts.domain)) {
          console.error(
            chalk.red(`  Unknown domain "${opts.domain}". Available: ${domains.join(", ")}`),
          );
          process.exit(1);
        }
        const types = syntheticDataFactory.listTypes(opts.domain);
        if (!types.includes(opts.type)) {
          console.error(
            chalk.red(
              `  Unknown type "${opts.type}" for domain "${opts.domain}". Available: ${types.join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const count = parseInt(opts.count, 10);
        if (!Number.isFinite(count) || count < 1) {
          console.error(chalk.red(`  --count must be a positive integer (got "${opts.count}")`));
          process.exit(1);
        }
        const seed = opts.seed === undefined ? undefined : parseInt(opts.seed, 10);
        if (opts.seed !== undefined && !Number.isFinite(seed)) {
          console.error(chalk.red(`  --seed must be an integer (got "${opts.seed}")`));
          process.exit(1);
        }
        // `SyntheticDataConfig.difficulty` is `"easy" | "medium" | "hard"`
        // (packages/core/src/synthetic/index.ts:11) and the value is written
        // verbatim onto every emitted item (`difficulty: config.difficulty ||
        // "medium"`, :247). Unvalidated, `--difficulty banana` produced a
        // dataset where every case was tagged "banana" — a silently corrupt
        // artefact, not an error. Validated like its siblings: fail closed.
        if (!SYNTHETIC_DIFFICULTIES.includes(opts.difficulty as SyntheticDifficulty)) {
          console.error(
            chalk.red(
              `  --difficulty must be one of ${SYNTHETIC_DIFFICULTIES.join("|")} (got "${opts.difficulty}")`,
            ),
          );
          process.exit(1);
        }

        const dataset = syntheticDataFactory.generate({
          domain: opts.domain,
          type: opts.type,
          count,
          seed,
          includeGroundTruth: opts.groundTruth,
          difficulty: opts.difficulty,
        });

        const format = opts.format.toLowerCase() === "csv" ? "csv" : "json";
        const outputPath =
          opts.output ?? `synthetic-${opts.domain}-${opts.type}.${format}`;
        fs.writeFileSync(outputPath, serializeSyntheticDataset(dataset, format), "utf-8");

        console.log();
        console.log(
          chalk.bold(
            `  Generated ${dataset.items.length} ${opts.domain}/${opts.type} items offline (no LLM call)`,
          ),
        );
        console.log(
          chalk.dim(`  Distinct inputs: ${dataset.metadata.qualityScore}%`) +
            (dataset.metadata.groundTruthCoverage !== undefined
              ? chalk.dim(`  ·  Labelled: ${dataset.metadata.groundTruthCoverage}%`)
              : ""),
        );
        if (opts.groundTruth && dataset.metadata.groundTruthCoverage === 0) {
          console.log(
            chalk.yellow(
              `  Note: the ${opts.domain}/${opts.type} pack ships no reference answers, so every item is unlabelled.`,
            ),
          );
        }
        console.log(`  ${chalk.green("✓")} Saved to ${chalk.cyan(outputPath)}`);
      },
    );

  gen
    .command("dataset")
    .description("Synthesize evaluation test cases from a system prompt or document")
    .requiredOption("--from <file>", "Path to source file (system prompt .txt or document .md/.txt)")
    .option("-n, --count <n>", "Number of test cases to generate", "20")
    .option(
      "--strategy <list>",
      "Comma-separated evolution strategies (reasoning,multi-context,comparative,hypothetical,edge-case,adversarial,paraphrase)",
      "",
    )
    .option("--model <model>", "LLM model for generation", "gpt-4o")
    .option("--provider <provider>", "Provider name", "openai")
    .option("--format <fmt>", "Output format: json or csv", "json")
    .option("--output <file>", "Output file path (default: synthesized-dataset.<format>)")
    .option("--source-type <type>", "Force source type: system-prompt or document (auto-detected by default)")
    .option("--chunk-size <n>", "Max characters per document chunk", "3000")
    .action(
      async (opts: {
        from: string;
        count: string;
        strategy: string;
        model: string;
        provider: string;
        format: string;
        output?: string;
        sourceType?: string;
        chunkSize: string;
      }) => {
        const { Synthesizer, createProvider } = (await import("@evalguard/core")) as any;

        const spinner = ora("Loading source file...").start();

        try {
          // ── Read source file ──
          const filePath = path.resolve(opts.from);
          if (!fs.existsSync(filePath)) {
            spinner.fail(`File not found: ${filePath}`);
            process.exit(1);
          }

          const sourceText = fs.readFileSync(filePath, "utf-8").trim();
          if (!sourceText) {
            spinner.fail("Source file is empty.");
            process.exit(1);
          }

          // ── Detect source type ──
          let sourceType: "system-prompt" | "document" = "document";
          if (opts.sourceType) {
            sourceType = opts.sourceType as "system-prompt" | "document";
          } else {
            // Heuristic: files < 2000 chars and named *prompt* or *system* are system prompts
            const basename = path.basename(filePath).toLowerCase();
            if (
              sourceText.length < 2000 ||
              basename.includes("prompt") ||
              basename.includes("system")
            ) {
              sourceType = "system-prompt";
            }
          }

          // ── Parse strategies ──
          const strategies = opts.strategy
            ? opts.strategy.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined; // undefined = use all 7

          // ── Build LLM call function ──
          const callLLM = await makeCallLLM(opts.provider, opts.model, createProvider);

          // ── Run synthesizer ──
          spinner.text = `Synthesizing ${opts.count} test cases using ${strategies ? strategies.join(", ") : "all 7"} strategies...`;

          const synth = new Synthesizer();
          const result = await synth.generate({
            ...(sourceType === "system-prompt"
              ? { systemPrompt: sourceText }
              : { document: sourceText }),
            count: parseInt(opts.count, 10),
            strategies,
            callLLM,
            chunkSize: parseInt(opts.chunkSize, 10),
          });

          spinner.stop();

          // ── Print summary ──
          console.log();
          console.log(chalk.bold(`  Synthesized ${result.testCases.length} test cases`));
          console.log(chalk.dim(`  Source type: ${sourceType}`));
          console.log(chalk.dim(`  Strategies: ${result.strategiesUsed.join(", ")}`));
          console.log(chalk.dim(`  Duration: ${result.durationMs}ms`));
          if (result.totalFiltered > 0) {
            console.log(chalk.dim(`  Filtered: ${result.totalFiltered} duplicates removed`));
          }

          // ── Preview first 3 ──
          console.log();
          for (const tc of result.testCases.slice(0, 3)) {
            const stratBadge = chalk.magenta(`[${tc.metadata.strategy}]`);
            console.log(
              `  ${stratBadge} ${chalk.cyan("Q:")} ${tc.input.slice(0, 80)}${tc.input.length > 80 ? "..." : ""}`,
            );
            console.log(
              `  ${" ".repeat(tc.metadata.strategy.length + 3)}${chalk.green("A:")} ${(tc.expectedOutput ?? "N/A").slice(0, 80)}`,
            );
            console.log();
          }
          if (result.testCases.length > 3) {
            console.log(chalk.dim(`  ... and ${result.testCases.length - 3} more`));
          }

          // ── Write output ──
          const format = opts.format.toLowerCase();
          const defaultFilename = `synthesized-dataset.${format === "csv" ? "csv" : "json"}`;
          const outputPath = opts.output ?? defaultFilename;

          if (format === "csv") {
            const csvRows = [
              "input,expectedOutput,strategy,sourceType,qualityScore",
              ...result.testCases.map((tc: any) =>
                [
                  csvEscape(tc.input),
                  csvEscape(tc.expectedOutput),
                  csvEscape(tc.metadata.strategy),
                  csvEscape(tc.metadata.sourceType),
                  String(tc.metadata.qualityScore ?? ""),
                ].join(","),
              ),
            ];
            fs.writeFileSync(outputPath, csvRows.join("\n"), "utf-8");
          } else {
            const outputData = {
              source: path.basename(filePath),
              sourceType,
              model: opts.model,
              generatedAt: new Date().toISOString(),
              totalCases: result.testCases.length,
              strategiesUsed: result.strategiesUsed,
              durationMs: result.durationMs,
              cases: result.testCases.map((tc: any) => ({
                input: tc.input,
                expectedOutput: tc.expectedOutput,
                metadata: tc.metadata,
              })),
            };
            fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), "utf-8");
          }

          console.log(`  ${chalk.green("\u2713")} Saved to ${chalk.cyan(outputPath)}`);
        } catch (err) {
          spinner.fail(
            `Synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      },
    );
}

/** Build an LLM call function from provider name + model. */

/** Escape a value for CSV output. */
function csvEscape(value: string): string {
  if (!value) return '""';
  // Wrap in quotes if it contains comma, newline, or quote
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
