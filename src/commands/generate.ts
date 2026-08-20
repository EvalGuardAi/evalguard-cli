/**
 * `evalguard generate tests` — Generate synthetic test cases
 * `evalguard generate assertions` — Auto-generate assertions for existing tests
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
import { makeCallLLM } from "../lib/call-llm.js";

type EvolutionStrategy = any;
type GeneratedTestCase = any;

export function registerGenerate(program: Command): void {
  const gen = program
    .command("generate")
    .description("Generate synthetic test data");

  // ─── generate tests ───
  gen
    .command("tests")
    .description("Generate test cases from a description")
    .argument("<description>", "What to test (e.g., 'customer support chatbot')")
    .option("-n, --count <n>", "Number of test cases", "10")
    .option("--model <model>", "LLM model for generation", "gpt-4o")
    .option("--provider <provider>", "Provider name", "openai")
    .option("--strategies <list>", "Evolution strategies (comma-separated)", "")
    .option("--output <file>", "Output file path", "generated-tests.json")
    .action(async (description: string, opts: { count: string; model: string; provider: string; strategies: string; output: string }) => {
      const { generateTestCases, createProvider } = await import("@evalguard/core") as any;

      const spinner = ora("Generating test cases...").start();

      try {
        const callLLM = await makeCallLLM(opts.provider, opts.model, createProvider);
        const strategies = opts.strategies
          ? opts.strategies.split(",").map((s: string) => s.trim()) as EvolutionStrategy[]
          : [];

        const result = await generateTestCases({
          description,
          count: parseInt(opts.count, 10),
          callLLM,
          strategies: strategies.length > 0 ? strategies : undefined,
        });

        spinner.stop();

        console.log();
        console.log(chalk.bold(`  Generated ${result.testCases.length} test cases`));
        console.log(chalk.dim(`  Strategies: ${result.strategies.join(", ")}`));
        console.log(chalk.dim(`  Duration: ${result.duration}ms`));
        if (result.totalFiltered > 0) {
          console.log(chalk.dim(`  Filtered: ${result.totalFiltered} duplicates removed`));
        }

        // Preview first 3
        console.log();
        for (const tc of result.testCases.slice(0, 3)) {
          console.log(`  ${chalk.cyan("Q:")} ${tc.input.slice(0, 80)}${tc.input.length > 80 ? "..." : ""}`);
          console.log(`  ${chalk.green("A:")} ${(tc.expected ?? "N/A").slice(0, 80)}`);
          console.log();
        }
        if (result.testCases.length > 3) {
          console.log(chalk.dim(`  ... and ${result.testCases.length - 3} more`));
        }

        // Save output
        const outputData = {
          description,
          model: opts.model,
          generatedAt: new Date().toISOString(),
          cases: result.testCases.map((tc: any) => ({
            input: tc.input,
            expectedOutput: tc.expected,
            strategy: tc.strategy,
            metadata: tc.metadata,
          })),
        };

        fs.writeFileSync(opts.output, JSON.stringify(outputData, null, 2));
        console.log(`  ${chalk.green("✓")} Saved to ${chalk.cyan(opts.output)}`);
      } catch (err) {
        spinner.fail(`Generation failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ─── generate assertions ───
  gen
    .command("assertions")
    .description("Auto-generate assertions for existing test cases")
    .argument("<file>", "Path to test cases JSON file")
    .option("--model <model>", "LLM model", "gpt-4o")
    .option("--provider <provider>", "Provider name", "openai")
    .option("--output <file>", "Output file path", "generated-assertions.json")
    .action(async (file: string, opts: { model: string; provider: string; output: string }) => {
      const { generateAssertions, createProvider } = await import("@evalguard/core") as any;

      const spinner = ora("Generating assertions...").start();

      try {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(`File not found: ${filePath}`);
          process.exit(1);
        }

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const cases: GeneratedTestCase[] = (data.cases ?? data).map((c: any) => ({
          input: c.input,
          expected: c.expectedOutput ?? c.expected,
          strategy: c.strategy ?? "base",
        }));

        const callLLM = await makeCallLLM(opts.provider, opts.model, createProvider);
        const results: Array<{ input: string; assertions: any[] }> = [];

        for (let i = 0; i < cases.length; i++) {
          spinner.text = `Generating assertions for case ${i + 1}/${cases.length}...`;
          const assertions = await generateAssertions({ testCase: cases[i], callLLM });
          results.push({ input: cases[i].input, assertions });
        }

        spinner.stop();
        console.log();
        console.log(chalk.bold(`  Generated assertions for ${results.length} test cases`));

        fs.writeFileSync(opts.output, JSON.stringify(results, null, 2));
        console.log(`  ${chalk.green("✓")} Saved to ${chalk.cyan(opts.output)}`);
      } catch (err) {
        spinner.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ─── generate rag ───
  gen
    .command("rag")
    .description("Generate RAG test cases from documents")
    .argument("<dir>", "Directory containing .txt/.md documents")
    .option("-n, --count <n>", "Number of test cases", "10")
    .option("--model <model>", "LLM model", "gpt-4o")
    .option("--provider <provider>", "Provider name", "openai")
    .option("--types <list>", "Question types (factual,inferential,comparative,multi-hop)", "factual,inferential,comparative")
    .option("--output <file>", "Output file path", "rag-tests.json")
    .action(async (dir: string, opts: { count: string; model: string; provider: string; types: string; output: string }) => {
      const { generateRAGTests, createProvider } = await import("@evalguard/core") as any;

      const spinner = ora("Loading documents...").start();

      try {
        const dirPath = path.resolve(dir);
        if (!fs.existsSync(dirPath)) {
          spinner.fail(`Directory not found: ${dirPath}`);
          process.exit(1);
        }

        const files = fs.readdirSync(dirPath).filter((f: string) => f.endsWith(".txt") || f.endsWith(".md"));
        if (files.length === 0) {
          spinner.fail("No .txt or .md files found in directory.");
          process.exit(1);
        }

        const documents = files.map((f: string) => fs.readFileSync(path.join(dirPath, f), "utf-8"));
        spinner.text = `Generating RAG tests from ${files.length} documents...`;

        const callLLM = await makeCallLLM(opts.provider, opts.model, createProvider);
        const questionTypes = opts.types.split(",").map((t: string) => t.trim()) as any[];

        const tests = await generateRAGTests({
          documents,
          count: parseInt(opts.count, 10),
          callLLM,
          questionTypes,
        });

        spinner.stop();
        console.log();
        console.log(chalk.bold(`  Generated ${tests.length} RAG test cases from ${files.length} documents`));

        const outputData = {
          sourceDir: dir,
          sourceFiles: files,
          generatedAt: new Date().toISOString(),
          cases: tests.map((tc: any) => ({
            input: tc.input,
            expectedOutput: tc.expected,
            strategy: tc.strategy,
            metadata: tc.metadata,
          })),
        };

        fs.writeFileSync(opts.output, JSON.stringify(outputData, null, 2));
        console.log(`  ${chalk.green("✓")} Saved to ${chalk.cyan(opts.output)}`);
      } catch (err) {
        spinner.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
