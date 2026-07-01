/**
 * `evalguard language detect` — text language identification.
 *
 *   evalguard language detect "Bonjour tout le monde" [--json]
 *
 * Runs the franc-min detector from @evalguard/core LOCALLY — no network, no API
 * key. (The /api/v1/language/detect route + SDKs exist for remote callers.)
 */
import { Command } from "commander";
import chalk from "chalk";
import { detectLanguage } from "@evalguard/core";

export function registerLanguage(program: Command): void {
  const cmd = program.command("language").description("Text language identification (franc-min, runs locally)");

  cmd
    .command("detect <text>")
    .description("Detect the language of a text string")
    .option("--min-length <n>", "Minimum length before attempting detection", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON", false)
    .action((text: string, opts: { minLength?: number; json?: boolean }) => {
      const d = detectLanguage(text, { minLength: opts.minLength });
      if (opts.json) {
        console.log(JSON.stringify(d, null, 2));
        return;
      }
      if (!d.reliable) {
        console.log(chalk.dim("  Undetermined — text too short or ambiguous."));
        return;
      }
      console.log();
      console.log(
        `  ${chalk.bold(d.name ?? d.iso6391 ?? d.iso6393)} ` +
          chalk.dim(`(${d.iso6391 ?? d.iso6393})`) +
          `  confidence ${chalk.cyan(d.confidence.toFixed(3))}`,
      );
      console.log();
    });
}
