/**
 * `evalguard compare <file1> <file2>` — Compare two eval result files
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

interface EvalResultFile {
  description?: string;
  timestamp?: string;
  results?: Array<{
    testIndex: number;
    input: string;
    output: string;
    expected?: string;
    score: number;
    passed: boolean;
    provider?: string;
    latencyMs?: number;
    assertions?: Array<{ type: string; passed: boolean; score: number }>;
  }>;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    duration?: number;
  };
  // Also support raw eval results
  cases?: Array<{
    input: string;
    actualOutput: string;
    expectedOutput?: string;
    score: number;
    passed: boolean;
    latency?: number;
  }>;
}

export function registerCompare(program: Command): void {
  program
    .command("compare")
    .description("Compare two evaluation result files")
    .argument("<file1>", "First result file (baseline)")
    .argument("<file2>", "Second result file (candidate)")
    .option("--threshold <n>", "Minimum score improvement to highlight", "0.05")
    .action((file1: string, file2: string, opts: { threshold: string }) => {
      const threshold = parseFloat(opts.threshold);

      const r1 = loadResults(file1);
      const r2 = loadResults(file2);

      if (!r1 || !r2) process.exit(1);

      console.log();
      console.log(chalk.bold("  Evaluation Comparison"));
      console.log(chalk.dim(`  Baseline: ${path.basename(file1)}`));
      console.log(chalk.dim(`  Candidate: ${path.basename(file2)}`));
      console.log();

      // Summary comparison
      const s1 = r1.summary;
      const s2 = r2.summary;

      if (s1 && s2) {
        const passRateDelta = s2.passRate - s1.passRate;
        const deltaColor = passRateDelta > 0 ? chalk.green : passRateDelta < 0 ? chalk.red : chalk.dim;
        const deltaStr = passRateDelta > 0 ? `+${(passRateDelta * 100).toFixed(1)}%` : `${(passRateDelta * 100).toFixed(1)}%`;

        console.log("  " + chalk.dim("─".repeat(60)));
        console.log(`  ${"Metric".padEnd(25)} ${"Baseline".padEnd(15)} ${"Candidate".padEnd(15)} ${"Delta"}`);
        console.log("  " + chalk.dim("─".repeat(60)));
        console.log(`  ${"Pass Rate".padEnd(25)} ${((s1.passRate * 100).toFixed(1) + "%").padEnd(15)} ${((s2.passRate * 100).toFixed(1) + "%").padEnd(15)} ${deltaColor(deltaStr)}`);
        console.log(`  ${"Passed".padEnd(25)} ${String(s1.passed).padEnd(15)} ${String(s2.passed).padEnd(15)} ${diffStr(s2.passed - s1.passed)}`);
        console.log(`  ${"Failed".padEnd(25)} ${String(s1.failed).padEnd(15)} ${String(s2.failed).padEnd(15)} ${diffStr(s2.failed - s1.failed, true)}`);
        console.log(`  ${"Total".padEnd(25)} ${String(s1.total).padEnd(15)} ${String(s2.total).padEnd(15)}`);
        if (s1.duration != null && s2.duration != null) {
          console.log(`  ${"Duration".padEnd(25)} ${(s1.duration + "ms").padEnd(15)} ${(s2.duration + "ms").padEnd(15)} ${diffStr(s2.duration - s1.duration, true)}ms`);
        }
        console.log("  " + chalk.dim("─".repeat(60)));
      }

      // Per-case comparison
      const cases1 = r1.results ?? r1.cases?.map((c, i) => ({ testIndex: i, input: c.input, score: c.score, passed: c.passed })) ?? [];
      const cases2 = r2.results ?? r2.cases?.map((c, i) => ({ testIndex: i, input: c.input, score: c.score, passed: c.passed })) ?? [];

      const maxLen = Math.max(cases1.length, cases2.length);
      let improved = 0;
      let regressed = 0;
      let unchanged = 0;

      console.log();
      for (let i = 0; i < maxLen; i++) {
        const c1 = cases1[i];
        const c2 = cases2[i];

        if (!c1 || !c2) continue;

        const scoreDelta = c2.score - c1.score;
        if (Math.abs(scoreDelta) < threshold) {
          unchanged++;
          continue;
        }

        if (scoreDelta > 0) {
          improved++;
          console.log(`  ${chalk.green("↑")} Case ${i}: ${c1.score.toFixed(2)} → ${c2.score.toFixed(2)} ${chalk.green(`+${scoreDelta.toFixed(2)}`)} ${chalk.dim(c1.input?.slice(0, 50) ?? "")}`);
        } else {
          regressed++;
          console.log(`  ${chalk.red("↓")} Case ${i}: ${c1.score.toFixed(2)} → ${c2.score.toFixed(2)} ${chalk.red(scoreDelta.toFixed(2))} ${chalk.dim(c1.input?.slice(0, 50) ?? "")}`);
        }
      }

      console.log();
      console.log(`  ${chalk.green(`${improved} improved`)} | ${chalk.red(`${regressed} regressed`)} | ${chalk.dim(`${unchanged} unchanged`)}`);
      console.log();

      // Overall verdict
      if (s1 && s2) {
        if (s2.passRate > s1.passRate) {
          console.log(`  ${chalk.green("✓")} Candidate is ${chalk.bold("better")} than baseline`);
        } else if (s2.passRate < s1.passRate) {
          console.log(`  ${chalk.red("✗")} Candidate is ${chalk.bold("worse")} than baseline`);
        } else {
          console.log(`  ${chalk.dim("=")} Results are ${chalk.bold("equivalent")}`);
        }
      }
      console.log();
    });
}

function loadResults(file: string): EvalResultFile | null {
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`File not found: ${filePath}`));
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(chalk.red(`Invalid JSON: ${filePath}`));
    return null;
  }
}

function diffStr(delta: number, inverseColor = false): string {
  const positive = inverseColor ? chalk.red : chalk.green;
  const negative = inverseColor ? chalk.green : chalk.red;
  if (delta > 0) return positive(`+${delta}`);
  if (delta < 0) return negative(String(delta));
  return chalk.dim("0");
}
