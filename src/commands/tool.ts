/**
 * `evalguard tool …` — manage first-class versioned + deployable Tools.
 *
 * Phase 2 (B): a managed Tool is a versioned, content-addressed
 * artifact (its `versionId` is the sha256 of its canonicalised `ToolConfig`),
 * deployable to arbitrary named environments. The typed schema
 * (`ToolConfig` = function spec + source code + setup schema + attributes)
 * REUSES the `ToolFunction` type from the prompt config.
 *
 * Subcommands:
 *   tool push   — import a tool-config JSON file as a new local version
 *   tool pull   — export a stored version's config JSON (stdout or --output)
 *   tool list   — list locally-stored tools and their latest version
 *   tool show   — pretty-print a version's config
 *   tool deploy — deploy a version to a named environment (--env)
 *
 * Everything is layered on the EXISTING `@evalguard/core` tool system — the
 * `FileToolStore`, `ToolRegistry` (content hashing / de-dup), the shared
 * `EnvironmentRegistry` and `ToolDeploymentManager`. This file adds only the CLI
 * shell + local persistence; no tool logic is duplicated here.
 *
 * SECURITY: this handles tool CONFIG (metadata) only — never secrets. A tool's
 * environment-variable VALUES are managed separately on the server and are
 * never read or written by these local commands.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import {
  FileToolStore,
  ToolRegistry,
  ToolDeploymentManager,
  hashToolConfig,
  validateToolConfig,
  type ToolConfig,
  type ToolVersion,
  type ToolStore,
  type ToolDeploymentRecord,
} from "@evalguard/core";
import { nodeFsAdapter, defaultEvalguardDir } from "./prompt.js";
import {
  loadEnvironments,
  buildEnvironmentRegistry,
  DeployLog,
} from "../lib/environments.js";

/** Default on-disk location for locally-managed tool versions. */
export function defaultToolDir(): string {
  return path.join(defaultEvalguardDir(), "tools");
}

/** Build a `FileToolStore` backed by the Node fs adapter. */
export function createToolStore(directory: string = defaultToolDir()): ToolStore {
  return new FileToolStore(directory, nodeFsAdapter);
}

/* ─── Pure helpers (exported for tests) ───────────────────────────────*/

/**
 * Parse + validate the raw text of a tool-config JSON file into a `ToolConfig`.
 * Throws with all structural errors if the config is invalid (must carry at
 * least a `function` spec or `sourceCode`).
 */
export function parseToolConfigText(text: string): ToolConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Tool config is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool config must be a JSON object");
  }
  const config = parsed as ToolConfig;
  const { valid, errors } = validateToolConfig(config);
  if (!valid) {
    throw new Error(`Invalid tool config: ${errors.join("; ")}`);
  }
  return config;
}

/**
 * Import a tool-config JSON as a NEW local version. Content-addressed de-dup:
 * if a stored version already has an identical (hashed) config, that existing
 * version is returned and NO new version is created — matching the core
 * `ToolRegistry` semantics. Pure w.r.t. IO except the injected `store`.
 */
export async function pushToolConfig(args: {
  store: ToolStore;
  name: string;
  toolConfigText: string;
  createdBy: string;
}): Promise<{ version: ToolVersion; deduped: boolean }> {
  const config = parseToolConfigText(args.toolConfigText);
  const versionId = hashToolConfig(config);
  const existing = await args.store.getVersions(args.name);

  const dup = existing.find((v) => v.versionId === versionId);
  if (dup) return { version: dup, deduped: true };

  const nextVersion = existing.length > 0 ? existing[existing.length - 1].version + 1 : 1;
  const version: ToolVersion = {
    name: args.name,
    version: nextVersion,
    versionId,
    config,
    createdAt: new Date(),
    createdBy: args.createdBy,
  };
  await args.store.save(args.name, version);
  return { version, deduped: false };
}

/**
 * Export a stored tool version's `ToolConfig` as pretty JSON. Loads the
 * requested version (or the latest); throws if the tool or version is absent.
 */
export async function pullToolConfig(args: {
  store: ToolStore;
  name: string;
  version?: number;
}): Promise<string> {
  const v =
    args.version !== undefined
      ? await args.store.getVersion(args.name, args.version)
      : await args.store.getLatest(args.name);
  if (!v) {
    throw new Error(
      args.version !== undefined
        ? `Tool "${args.name}" version ${args.version} not found`
        : `Tool "${args.name}" not found`,
    );
  }
  return JSON.stringify(v.config, null, 2);
}

/**
 * Deploy a stored tool version to a named environment. Fully reuses the core
 * primitives:
 *   - the `EnvironmentRegistry` (rebuilt from the env store) rejects deploys to
 *     unknown environments;
 *   - a `ToolRegistry` is hydrated from the stored versions so the
 *     `ToolDeploymentManager` resolves the exact version being deployed;
 *   - the prior deployment log for this tool is REPLAYED through the manager so
 *     the returned record's `previousDeploymentId` / status transitions match
 *     what the server would compute.
 * The new event is appended to the deployment log.
 */
export async function deployTool(args: {
  store: ToolStore;
  environments: import("../lib/environments.js").SerializedEnvironment[];
  deployLog: DeployLog;
  name: string;
  env: string;
  version?: number;
  deployedBy: string;
}): Promise<ToolDeploymentRecord> {
  const envRegistry = buildEnvironmentRegistry(args.environments);
  // Reject deploys to unknown environments (core invariant).
  envRegistry.requireEnvironment(args.env);

  const versions = await args.store.getVersions(args.name);
  if (versions.length === 0) {
    throw new Error(`Tool "${args.name}" not found`);
  }
  const target =
    args.version !== undefined
      ? versions.find((v) => v.version === args.version)
      : versions[versions.length - 1];
  if (!target) {
    throw new Error(`Tool "${args.name}" version ${args.version} not found`);
  }

  // Hydrate a core ToolRegistry from the stored versions (ascending order so
  // version numbers + content ids reproduce exactly), then a deployment manager
  // bound to it and the environment registry.
  const registry = new ToolRegistry();
  for (const v of versions) registry.registerTool(v.name, v.config, v.createdBy);
  const manager = new ToolDeploymentManager(registry, envRegistry);

  // Replay prior deployments for this tool so state transitions are accurate.
  const prior = await args.deployLog.entriesFor("tool", args.name);
  for (const e of prior) manager.setDeployment(e.name, e.env, e.version, e.deployedBy);

  const record = manager.setDeployment(args.name, args.env, target.version, args.deployedBy);
  await args.deployLog.append({
    artifact: "tool",
    name: args.name,
    env: args.env,
    version: target.version,
    deployedBy: args.deployedBy,
    deployedAt: record.deployedAt.toISOString(),
  });
  return record;
}

/* ─── Rendering for `show` ────────────────────────────────────────────*/

function describeToolConfig(config: ToolConfig): string[] {
  const lines: string[] = [`  ${chalk.bold("Config")}`];
  if (config.function) {
    lines.push(`    ${chalk.dim("function".padEnd(14))}${config.function.name}`);
    if (config.function.description) {
      lines.push(`    ${chalk.dim("description".padEnd(14))}${config.function.description}`);
    }
    if (config.function.strict !== undefined) {
      lines.push(`    ${chalk.dim("strict".padEnd(14))}${String(config.function.strict)}`);
    }
    if (config.function.parameters !== undefined) {
      lines.push(`    ${chalk.dim("parameters".padEnd(14))}${JSON.stringify(config.function.parameters)}`);
    }
  }
  if (config.sourceCode !== undefined) {
    lines.push(`    ${chalk.dim("sourceCode".padEnd(14))}${chalk.dim(`(${config.sourceCode.length} chars)`)}`);
  }
  if (config.setupSchema !== undefined) {
    lines.push(`    ${chalk.dim("setupSchema".padEnd(14))}${JSON.stringify(config.setupSchema)}`);
  }
  if (config.attributes !== undefined) {
    lines.push(`    ${chalk.dim("attributes".padEnd(14))}${JSON.stringify(config.attributes)}`);
  }
  return lines;
}

/* ─── Command registration ────────────────────────────────────────────*/

export function registerTool(program: Command): void {
  const tool = program
    .command("tool")
    .description("Manage versioned, deployable Tools (function spec + source code + setup schema)");

  // ── tool push ──
  tool
    .command("push")
    .description("Import a tool-config JSON file as a new local tool version")
    .requiredOption("-f, --file <path>", "Path to a tool-config JSON file")
    .option("-n, --name <name>", "Tool name (defaults to the file's base name)")
    .option("--by <author>", "Author recorded on the version", "cli")
    .option("--dir <path>", "Tool store directory (defaults to ~/.evalguard/tools)")
    .action(async (opts: { file: string; name?: string; by: string; dir?: string }) => {
      const filePath = path.resolve(opts.file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }
      const name = opts.name ?? path.basename(filePath).replace(/\.(json|tool\.json)$/i, "");
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        console.error(chalk.red(`Failed to read file: ${(err as Error).message}`));
        process.exit(1);
      }

      const store = createToolStore(opts.dir);
      let result: { version: ToolVersion; deduped: boolean };
      try {
        result = await pushToolConfig({ store, name, toolConfigText: text, createdBy: opts.by });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }

      console.log();
      if (result.deduped) {
        console.log(
          `  ${chalk.yellow("=")} ${chalk.cyan(name)} config is identical to ${chalk.bold(`v${result.version.version}`)} — reused (no new version)`,
        );
      } else {
        console.log(
          `  ${chalk.green("✓")} Pushed ${chalk.cyan(name)} ${chalk.bold(`v${result.version.version}`)} ${chalk.dim(`(${result.version.versionId.slice(0, 12)}…)`)}`,
        );
      }
      console.log(
        chalk.dim(`  Deploy it with: evalguard tool deploy ${name} --env production --version ${result.version.version}`),
      );
      console.log();
    });

  // ── tool pull ──
  tool
    .command("pull")
    .description("Export a stored tool version's config as JSON")
    .argument("<name>", "Tool name")
    .option("-v, --version <n>", "Version number (defaults to the latest)")
    .option("-o, --output <path>", "Write to a file instead of stdout")
    .option("--dir <path>", "Tool store directory (defaults to ~/.evalguard/tools)")
    .action(async (name: string, opts: { version?: string; output?: string; dir?: string }) => {
      const version = opts.version !== undefined ? Number(opts.version) : undefined;
      if (version !== undefined && !Number.isInteger(version)) {
        console.error(chalk.red(`--version must be an integer (got "${opts.version}")`));
        process.exit(1);
      }
      const store = createToolStore(opts.dir);
      let text: string;
      try {
        text = await pullToolConfig({ store, name, version });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }

      if (opts.output) {
        const outPath = path.resolve(opts.output);
        fs.writeFileSync(outPath, `${text}\n`, "utf-8");
        console.error(chalk.green(`✓ Wrote ${outPath}`));
      } else {
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      }
    });

  // ── tool list ──
  tool
    .command("list")
    .description("List locally-stored tools and their latest version")
    .option("--dir <path>", "Tool store directory (defaults to ~/.evalguard/tools)")
    .action(async (opts: { dir?: string }) => {
      const store = createToolStore(opts.dir);
      const names = await store.listTools();
      if (names.length === 0) {
        console.log(chalk.dim("  No tools stored yet. Create one with `evalguard tool push`."));
        return;
      }
      console.log();
      console.log(`  ${chalk.bold("Tools")} ${chalk.dim(`(${names.length})`)}`);
      for (const name of names.sort()) {
        const versions = await store.getVersions(name);
        const latest = versions[versions.length - 1];
        const kind = latest?.config.function
          ? chalk.green("function")
          : latest?.config.sourceCode !== undefined
            ? chalk.blue("source")
            : chalk.dim("—");
        console.log(
          `    ${chalk.cyan(name.padEnd(28))}${chalk.dim(`v${latest?.version ?? "?"}`).padEnd(14)}${kind}`,
        );
      }
      console.log();
    });

  // ── tool show ──
  tool
    .command("show")
    .description("Show a stored tool version's config")
    .argument("<name>", "Tool name")
    .option("-v, --version <n>", "Version number (defaults to the latest)")
    .option("--json", "Print the raw version as JSON")
    .option("--dir <path>", "Tool store directory (defaults to ~/.evalguard/tools)")
    .action(async (name: string, opts: { version?: string; json?: boolean; dir?: string }) => {
      const version = opts.version !== undefined ? Number(opts.version) : undefined;
      if (version !== undefined && !Number.isInteger(version)) {
        console.error(chalk.red(`--version must be an integer (got "${opts.version}")`));
        process.exit(1);
      }
      const store = createToolStore(opts.dir);
      const v =
        version !== undefined
          ? await store.getVersion(name, version)
          : await store.getLatest(name);
      if (!v) {
        console.error(
          chalk.red(
            version !== undefined
              ? `  Tool "${name}" version ${version} not found`
              : `  Tool "${name}" not found`,
          ),
        );
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(v, null, 2));
        return;
      }

      console.log();
      console.log(
        `  ${chalk.bold.cyan(v.name)} ${chalk.bold(`v${v.version}`)} ${chalk.dim(`· ${v.versionId.slice(0, 12)}… · by ${v.createdBy}`)}`,
      );
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      for (const line of describeToolConfig(v.config)) console.log(line);
      console.log();
    });

  // ── tool deploy ──
  tool
    .command("deploy")
    .description("Deploy a tool version to a named environment")
    .argument("<name>", "Tool name")
    .requiredOption("-e, --env <name>", "Target environment (must be registered; see `evalguard env`)")
    .option("-v, --version <n>", "Version number (defaults to the latest)")
    .option("--by <author>", "Author recorded on the deployment", "cli")
    .option("--dir <path>", "Tool store directory (defaults to ~/.evalguard/tools)")
    .option(
      "--environments-file <path>",
      "Environments file (defaults to ~/.evalguard/environments.json)",
    )
    .option("--deployments-file <path>", "Deployment log file (defaults to ~/.evalguard/deployments.json)")
    .action(
      async (
        name: string,
        opts: {
          env: string;
          version?: string;
          by: string;
          dir?: string;
          environmentsFile?: string;
          deploymentsFile?: string;
        },
      ) => {
        const version = opts.version !== undefined ? Number(opts.version) : undefined;
        if (version !== undefined && !Number.isInteger(version)) {
          console.error(chalk.red(`--version must be an integer (got "${opts.version}")`));
          process.exit(1);
        }
        const store = createToolStore(opts.dir);
        const environments = await loadEnvironments(opts.environmentsFile);
        const deployLog = new DeployLog(opts.deploymentsFile);

        let record: ToolDeploymentRecord;
        try {
          record = await deployTool({
            store,
            environments,
            deployLog,
            name,
            env: opts.env,
            version,
            deployedBy: opts.by,
          });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        console.log();
        console.log(
          `  ${chalk.green("✓")} Deployed ${chalk.cyan(name)} ${chalk.bold(`v${record.version}`)} to ${chalk.magenta(record.env)} ${chalk.dim(`(by ${record.deployedBy})`)}`,
        );
        console.log();
      },
    );
}
