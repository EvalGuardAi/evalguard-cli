/**
 * `evalguard generate dataset` — Synthesize evaluation test cases from
 * a system prompt file or document, using 7 evolution strategies.
 *
 * Usage:
 *   evalguard generate dataset --from <file> --count 50 --strategy reasoning,edge-case
 *   evalguard generate dataset --from prompt.txt --count 20 --format csv --output tests.csv
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";

export function registerGenerateDataset(program: Command): void {
  // Find or create the "generate" parent command
  let gen = program.commands.find((c) => c.name() === "generate");
  if (!gen) {
    gen = program.command("generate").description("Generate synthetic test data");
  }

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
async function makeCallLLM(
  providerName: string,
  model: string,
  createProvider: any,
): Promise<(prompt: string) => Promise<string>> {
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const envKey =
    envMap[providerName] ?? `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const apiKey = process.env[envKey] ?? process.env.EVALGUARD_PROVIDER_KEY ?? "";

  const provider = createProvider(providerName, apiKey);
  return async (prompt: string) => {
    const response = await provider.chat(
      [{ role: "user", content: prompt }],
      { model },
    );
    return response.content;
  };
}

/** Escape a value for CSV output. */
function csvEscape(value: string): string {
  if (!value) return '""';
  // Wrap in quotes if it contains comma, newline, or quote
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
