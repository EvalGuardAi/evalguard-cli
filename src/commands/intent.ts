/**
 * `evalguard intent classify` — classify a prompt's intent, data-sensitivity,
 * and governance risk using EvalGuard's deterministic core classifier. Local +
 * offline (no API key), so it can gate CI or be piped over a prompt corpus.
 * Competitor-gap Phase 3 (governance: intent + identity).
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import { classifyPromptIntent, type SensitivityLevel } from "@evalguard/core";

const FLOORS: SensitivityLevel[] = ["public", "internal", "confidential", "restricted"];

function readPrompt(arg: string | undefined, file?: string): string {
  if (file) return fs.readFileSync(file, "utf-8");
  if (arg) return arg;
  // stdin fallback (piped input)
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

const RISK_COLOR = (r: number) => (r >= 0.5 ? chalk.red : r >= 0.3 ? chalk.yellow : chalk.green);

export function registerIntent(program: Command): void {
  const intent = program.command("intent").description("Prompt-intent governance");

  intent
    .command("classify [prompt]")
    .description("Classify a prompt's intent, sensitivity, and risk (local, offline)")
    .option("-f, --file <path>", "Read the prompt from a file")
    .option("-s, --sensitivity-floor <level>", `Floor: ${FLOORS.join(", ")}`)
    .option("--json", "Emit JSON")
    .action((promptArg: string | undefined, opts: { file?: string; sensitivityFloor?: string; json?: boolean }) => {
      if (opts.sensitivityFloor && !FLOORS.includes(opts.sensitivityFloor as SensitivityLevel)) {
        console.error(chalk.red(`Invalid --sensitivity-floor "${opts.sensitivityFloor}". Use: ${FLOORS.join(", ")}`));
        process.exit(1);
      }
      const prompt = readPrompt(promptArg, opts.file).trim();
      if (!prompt) {
        console.error(chalk.red("No prompt provided. Pass an argument, --file, or pipe via stdin."));
        process.exit(1);
      }

      const result = classifyPromptIntent(prompt, {
        sensitivityFloor: opts.sensitivityFloor as SensitivityLevel | undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.bold("Intent:")}      ${chalk.cyan(result.intent)} ${chalk.dim(`(confidence ${(result.confidence * 100).toFixed(0)}%)`)}`);
      console.log(`${chalk.bold("Sensitivity:")} ${result.sensitivity}`);
      console.log(`${chalk.bold("Risk score:")}  ${RISK_COLOR(result.riskScore)(`${(result.riskScore * 100).toFixed(0)}/100`)}`);
      if (result.signals.length > 0) {
        console.log(chalk.dim("Signals:"));
        for (const s of result.signals) console.log(chalk.dim(`  • ${s}`));
      }
    });
}
