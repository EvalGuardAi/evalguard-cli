/**
 * `evalguard agent-rules` — generate secure-coding rule packs for AI coding
 * agents (Cursor / Claude Code / Copilot / Gemini) from EvalGuard's scanner
 * pattern library, so generated code follows the same policy EvalGuard enforces
 * at runtime. Competitor-gap Phase 5 (Arnica convergence).
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderAllRulePacks, renderRulePack, type RuleTarget } from "@evalguard/core";

const VALID_TARGETS: RuleTarget[] = ["cursor", "claude", "agents", "copilot"];

export function registerAgentRules(program: Command): void {
  program
    .command("agent-rules")
    .description(
      "Generate secure-coding rule packs (.cursorrules / CLAUDE.md / AGENTS.md / copilot-instructions.md) from EvalGuard's scanner patterns",
    )
    .option("-t, --target <target>", `Target: ${VALID_TARGETS.join(", ")}, or all`, "all")
    .option("-o, --out <dir>", "Output directory (repo root)", ".")
    .option("-c, --category <category...>", "Restrict to these vulnerability categories")
    .action((opts: { target: string; out: string; category?: string[] }) => {
      if (opts.target !== "all" && !VALID_TARGETS.includes(opts.target as RuleTarget)) {
        console.error(chalk.red(`Invalid --target "${opts.target}". Use: ${VALID_TARGETS.join(", ")}, or all`));
        process.exit(1);
      }
      const ruleOpts = opts.category && opts.category.length > 0 ? { categories: opts.category } : {};
      const packs =
        opts.target === "all"
          ? renderAllRulePacks(ruleOpts)
          : [renderRulePack(opts.target as RuleTarget, ruleOpts)];

      for (const pack of packs) {
        const dest = path.resolve(opts.out, pack.filename);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, pack.content, "utf-8");
        console.log(`${chalk.green("✓")} wrote ${chalk.cyan(pack.filename)}`);
      }
      console.log(
        chalk.dim(
          "\nCommit these so your AI coding agent follows EvalGuard's secure-coding policy at generation time.",
        ),
      );
    });
}
