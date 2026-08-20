/**
 * `evalguard env …` — manage arbitrary NAMED deployment environments.
 *
 * Phase 2 (A): deployment targets are no longer the hardcoded
 * `staging | production` pair — they are a first-class, workspace-scoped set of
 * named environments (each an `Environment` with a workspace-unique name and an
 * `EnvironmentTag`). `staging` + `production` are SEEDED so every existing
 * `--env staging|production` caller keeps working unchanged.
 *
 * Subcommands:
 *   env list             — list the workspace's environments
 *   env create <name>    — create a new environment (--tag default|other)
 *   env remove <name>    — remove an environment
 *
 * All environment logic (uniqueness, the single `default` invariant) lives in
 * `@evalguard/core`'s `EnvironmentRegistry`; this file adds only the CLI shell +
 * local JSON persistence (see ../lib/environments).
 */
import { Command } from "commander";
import chalk from "chalk";
import { ENVIRONMENT_TAG_VALUES, type EnvironmentTag } from "@evalguard/core";
import {
  loadEnvironments,
  saveEnvironments,
  addEnvironment,
  removeEnvironment,
  type SerializedEnvironment,
} from "../lib/environments.js";

/** Validate a `--tag` flag against the core tag enum. */
export function parseEnvironmentTag(raw: string | undefined): EnvironmentTag {
  if (raw === undefined) return "other";
  const members = ENVIRONMENT_TAG_VALUES as readonly string[];
  if (!members.includes(raw)) {
    throw new Error(`--tag must be one of ${members.join("|")} (got "${raw}")`);
  }
  return raw as EnvironmentTag;
}

function renderEnvironments(list: SerializedEnvironment[]): string[] {
  const lines: string[] = [];
  lines.push(`  ${chalk.bold("Environments")} ${chalk.dim(`(${list.length})`)}`);
  for (const e of list) {
    const tag =
      e.tag === "default" ? chalk.green("default") : chalk.dim(String(e.tag));
    lines.push(`    ${chalk.cyan(e.name.padEnd(24))}${tag}`);
  }
  return lines;
}

export function registerEnv(program: Command): void {
  const env = program
    .command("env")
    .description("Manage named deployment environments (arbitrary, not just staging/production)");

  // ── env list ──
  env
    .command("list")
    .description("List the workspace's named environments")
    .option("--file <path>", "Environments file (defaults to ~/.evalguard/environments.json)")
    .action(async (opts: { file?: string }) => {
      const list = await loadEnvironments(opts.file);
      console.log();
      for (const line of renderEnvironments(list)) console.log(line);
      console.log();
    });

  // ── env create ──
  env
    .command("create")
    .description("Create a new named environment")
    .argument("<name>", "Environment name (workspace-unique)")
    .option(
      "--tag <tag>",
      `Environment tag (${(ENVIRONMENT_TAG_VALUES as readonly string[]).join("|")}); at most one "default"`,
    )
    .option("--file <path>", "Environments file (defaults to ~/.evalguard/environments.json)")
    .action(async (name: string, opts: { tag?: string; file?: string }) => {
      let tag: EnvironmentTag;
      try {
        tag = parseEnvironmentTag(opts.tag);
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }
      const list = await loadEnvironments(opts.file);
      let next: SerializedEnvironment[];
      try {
        next = addEnvironment(list, name, tag);
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }
      await saveEnvironments(next, opts.file);
      console.log();
      console.log(
        `  ${chalk.green("✓")} Created environment ${chalk.cyan(name)} ${chalk.dim(`(tag: ${tag})`)}`,
      );
      console.log(chalk.dim(`  Deploy to it with: evalguard tool deploy <tool> --env ${name}`));
      console.log();
    });

  // ── env remove ──
  env
    .command("remove")
    .description("Remove a named environment")
    .argument("<name>", "Environment name")
    .option("--file <path>", "Environments file (defaults to ~/.evalguard/environments.json)")
    .action(async (name: string, opts: { file?: string }) => {
      const list = await loadEnvironments(opts.file);
      const { list: next, removed } = removeEnvironment(list, name);
      if (!removed) {
        console.error(chalk.red(`  Environment "${name}" not found`));
        process.exit(1);
      }
      await saveEnvironments(next, opts.file);
      console.log();
      console.log(`  ${chalk.green("✓")} Removed environment ${chalk.cyan(name)}`);
      console.log();
    });
}
