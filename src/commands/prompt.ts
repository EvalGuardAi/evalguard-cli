/**
 * `evalguard prompt …` — manage first-class typed prompt versions from the CLI.
 *
 * A prompt version is a typed artifact: a `PromptConfig`
 * (model + the standard LLM generation parameters + tools), a
 * structured `PromptTemplate` (a completion string or an ordered ChatTemplate),
 * and a template language. The portable single-file representation is the
 * `.prompt` format (frontmatter + role-tagged blocks) — EvalGuard's portable
 * prompt format that round-trips across all EvalGuard SDKs.
 *
 * Subcommands:
 *   prompt push   — import a `.prompt` file as a new local version
 *   prompt pull   — export a stored version to `.prompt` (stdout or --output)
 *   prompt create — create a new version from typed --flags (+ optional template)
 *   prompt show   — pretty-print a version's typed config + template
 *   prompt list   — list locally-stored prompts and their latest version
 *
 * Everything is layered on the EXISTING `@evalguard/core` prompt code — the
 * `.prompt` (de)serializer, `PromptConfig` validation, template helpers and the
 * `FilePromptStore`. This file adds only the CLI shell + a Node fs adapter; no
 * prompt logic is duplicated here.
 *
 * SECURITY: this handles prompt CONFIG (metadata) only — never secrets. The
 * `.prompt` (de)serializer in core reads/writes exactly the caller-supplied
 * config; no environment values or credentials are ever injected. Local
 * versions are written under `~/.evalguard/prompts` with owner-only perms.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  parsePromptFile,
  serializePromptFile,
  promptFileFrom,
  validatePromptConfig,
  isChatTemplate,
  extractTemplateVariables,
  FilePromptStore,
  MODEL_PROVIDER_VALUES,
  MODEL_ENDPOINT_VALUES,
  TEMPLATE_LANGUAGE_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  RESPONSE_FORMAT_TYPE_VALUES,
  type PromptFile,
  type PromptConfig,
  type PromptTemplate,
  type PromptVersion,
  type PromptStore,
  type FileSystemAdapter,
  type ReasoningEffort,
  type StopSequence,
  type ResponseFormat,
  type TemplateLanguage,
  PromptDeploymentManager,
  type DeploymentRecord,
} from "@evalguard/core";
import {
  loadEnvironments,
  buildEnvironmentRegistry,
  DeployLog,
  type SerializedEnvironment,
} from "../lib/environments.js";

/* ─── Node fs adapter for the core FilePromptStore ────────────────────
 * The core store is fs-agnostic (it takes a `FileSystemAdapter`) so it can run
 * in the browser, in tests, or on Node. This is the Node binding. Directories
 * are created owner-only (0o700); files inherit the default umask but live
 * inside that private directory. */
export const nodeFsAdapter: FileSystemAdapter = {
  async readFile(p: string): Promise<string> {
    return fsp.readFile(p, "utf-8");
  },
  async writeFile(p: string, content: string): Promise<void> {
    await fsp.writeFile(p, content, "utf-8");
  },
  async listFiles(directory: string): Promise<string[]> {
    return fsp.readdir(directory);
  },
  async deleteFile(p: string): Promise<void> {
    await fsp.rm(p, { force: true });
  },
  async exists(p: string): Promise<boolean> {
    return fs.existsSync(p);
  },
  async mkdir(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true, mode: 0o700 });
  },
};

/** Root directory for all locally-managed EvalGuard CLI artifacts. */
export function defaultEvalguardDir(): string {
  return path.join(os.homedir(), ".evalguard");
}

/** Default on-disk location for locally-managed prompt versions. */
export function defaultPromptDir(): string {
  return path.join(defaultEvalguardDir(), "prompts");
}

/** Build a `FilePromptStore` backed by the Node fs adapter. */
export function createPromptStore(directory: string = defaultPromptDir()): PromptStore {
  return new FilePromptStore(directory, nodeFsAdapter);
}

/* ─── Pure helpers (exported for tests) ───────────────────────────────*/

/**
 * Derive the opaque `content` string for a version from its structured
 * template. `content` is the legacy field used for diff/search/back-compat; the
 * typed `template` is the source of truth. We keep `content` human-readable:
 *   - no template          → ""
 *   - completion string    → the string verbatim
 *   - chat template        → `role[(name)]: content` blocks joined by blank lines
 */
export function deriveContentFromTemplate(template: PromptTemplate | undefined): string {
  if (template === undefined) return "";
  if (isChatTemplate(template)) {
    return template
      .map((m) => `${m.role}${m.name !== undefined ? `(${m.name})` : ""}: ${m.content}`)
      .join("\n\n");
  }
  return template;
}

/**
 * Build a `PromptVersion` from a parsed `.prompt` file. Validates the config and
 * throws with all problems if it is structurally invalid. The typed fields
 * (config / template / templateLanguage) are attached and `content` is derived
 * from the template so legacy content-only tooling keeps working.
 */
export function buildVersionFromPromptFile(
  file: PromptFile,
  name: string,
  version: number,
  createdBy: string,
): PromptVersion {
  const { valid, errors } = validatePromptConfig(file.config);
  if (!valid) {
    throw new Error(`Invalid prompt config: ${errors.join("; ")}`);
  }
  const v: PromptVersion = {
    name,
    version,
    content: deriveContentFromTemplate(file.template),
    metadata: { model: file.config.model },
    status: "draft",
    createdAt: new Date(),
    createdBy,
    config: file.config,
  };
  if (file.template !== undefined) v.template = file.template;
  if (file.templateLanguage !== undefined) v.templateLanguage = file.templateLanguage;
  return v;
}

/** Next version number for a prompt in a store (1 if brand new). */
export async function nextVersionNumber(store: PromptStore, name: string): Promise<number> {
  const latest = await store.getLatest(name);
  return latest ? latest.version + 1 : 1;
}

/**
 * Import the raw text of a `.prompt` file as a NEW local version. Parses,
 * validates, computes the next version number and persists. Returns the saved
 * version. Pure w.r.t. IO except the injected `store`, so it is unit-testable.
 */
export async function pushPromptFile(args: {
  store: PromptStore;
  name: string;
  promptFileText: string;
  createdBy: string;
}): Promise<PromptVersion> {
  const file = parsePromptFile(args.promptFileText);
  const version = await nextVersionNumber(args.store, args.name);
  const built = buildVersionFromPromptFile(file, args.name, version, args.createdBy);
  await args.store.save(args.name, built);
  return built;
}

/**
 * Export a stored version to `.prompt` text. Loads the requested version (or the
 * latest), bridges it to a `PromptFile` and serializes. Throws if the prompt or
 * version does not exist, or if it is a legacy content-only version with no
 * typed `config` (which cannot be expressed as a portable `.prompt` file).
 */
export async function pullPromptFile(args: {
  store: PromptStore;
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
        ? `Prompt "${args.name}" version ${args.version} not found`
        : `Prompt "${args.name}" not found`,
    );
  }
  const file = promptFileFrom({
    config: v.config,
    template: v.template,
    templateLanguage: v.templateLanguage,
  });
  return serializePromptFile(file);
}

/**
 * Deploy a stored prompt version to a named environment. Reuses the core
 * primitives end-to-end: the `EnvironmentRegistry` (rebuilt from the env store)
 * rejects deploys to unknown environments, and the `PromptDeploymentManager`
 * computes the deployment record — the prior deployment log for this prompt is
 * REPLAYED through the manager so `previousDeploymentId` / status transitions
 * match what the server would compute. The version must exist in the local
 * store. Pure w.r.t. IO except the injected `store` + `deployLog`.
 */
export async function deployPrompt(args: {
  store: PromptStore;
  environments: SerializedEnvironment[];
  deployLog: DeployLog;
  name: string;
  env: string;
  version?: number;
  deployedBy: string;
}): Promise<DeploymentRecord> {
  const envRegistry = buildEnvironmentRegistry(args.environments);
  envRegistry.requireEnvironment(args.env);

  const target =
    args.version !== undefined
      ? await args.store.getVersion(args.name, args.version)
      : await args.store.getLatest(args.name);
  if (!target) {
    throw new Error(
      args.version !== undefined
        ? `Prompt "${args.name}" version ${args.version} not found`
        : `Prompt "${args.name}" not found`,
    );
  }

  const manager = new PromptDeploymentManager(envRegistry);
  const prior = await args.deployLog.entriesFor("prompt", args.name);
  for (const e of prior) manager.setDeployment(e.name, e.env, e.version, e.deployedBy);

  const record = manager.setDeployment(args.name, args.env, target.version, args.deployedBy);
  await args.deployLog.append({
    artifact: "prompt",
    name: args.name,
    env: args.env,
    version: target.version,
    deployedBy: args.deployedBy,
    deployedAt: record.deployedAt.toISOString(),
  });
  return record;
}

/* ─── Flag → PromptConfig (for `prompt create`) ───────────────────────*/

export interface CreateFlags {
  model?: string;
  provider?: string;
  endpoint?: string;
  temperature?: string;
  maxTokens?: string;
  topP?: string;
  seed?: string;
  presencePenalty?: string;
  frequencyPenalty?: string;
  reasoningEffort?: string;
  responseFormat?: string;
  stop?: string[];
}

/** Parse a required-numeric flag, throwing a clear error on non-numbers. */
function parseNumberFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`--${flag} must be a number (got "${raw}")`);
  }
  return n;
}

/**
 * Build a `PromptConfig` from CLI flags. Numeric flags are parsed and validated;
 * `--reasoning-effort` accepts the high|medium|low enum OR an integer token
 * budget (the standard reasoning-effort union — named levels or an integer
 * budget). The result is run through `validatePromptConfig`; invalid configs
 * throw with all errors.
 */
export function buildConfigFromFlags(flags: CreateFlags): PromptConfig {
  if (!flags.model || flags.model.trim() === "") {
    throw new Error("--model is required");
  }
  const config: PromptConfig = { model: flags.model };

  if (flags.provider !== undefined) config.provider = flags.provider;
  if (flags.endpoint !== undefined) config.endpoint = flags.endpoint;

  const temperature = parseNumberFlag(flags.temperature, "temperature");
  if (temperature !== undefined) config.temperature = temperature;
  const maxTokens = parseNumberFlag(flags.maxTokens, "max-tokens");
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  const topP = parseNumberFlag(flags.topP, "top-p");
  if (topP !== undefined) config.topP = topP;
  const seed = parseNumberFlag(flags.seed, "seed");
  if (seed !== undefined) config.seed = seed;
  const presencePenalty = parseNumberFlag(flags.presencePenalty, "presence-penalty");
  if (presencePenalty !== undefined) config.presencePenalty = presencePenalty;
  const frequencyPenalty = parseNumberFlag(flags.frequencyPenalty, "frequency-penalty");
  if (frequencyPenalty !== undefined) config.frequencyPenalty = frequencyPenalty;

  if (flags.reasoningEffort !== undefined) {
    const enumMembers = OPENAI_REASONING_EFFORT_VALUES as readonly string[];
    if (enumMembers.includes(flags.reasoningEffort)) {
      config.reasoningEffort = flags.reasoningEffort as ReasoningEffort;
    } else {
      const budget = Number(flags.reasoningEffort);
      if (Number.isNaN(budget)) {
        throw new Error(
          `--reasoning-effort must be one of ${enumMembers.join("|")} or an integer token budget (got "${flags.reasoningEffort}")`,
        );
      }
      config.reasoningEffort = budget;
    }
  }

  if (flags.responseFormat !== undefined) {
    const rf: ResponseFormat = { type: flags.responseFormat };
    config.responseFormat = rf;
  }

  if (flags.stop !== undefined && flags.stop.length > 0) {
    const stop: StopSequence = flags.stop.length === 1 ? flags.stop[0] : flags.stop;
    config.stop = stop;
  }

  const { valid, errors } = validatePromptConfig(config);
  if (!valid) {
    throw new Error(`Invalid prompt config: ${errors.join("; ")}`);
  }
  return config;
}

/* ─── Rendering helpers for `show` ────────────────────────────────────*/

function describeTemplate(template: PromptTemplate | undefined): string[] {
  const lines: string[] = [];
  if (template === undefined) {
    lines.push(chalk.dim("    (no template)"));
    return lines;
  }
  if (isChatTemplate(template)) {
    lines.push(`  ${chalk.bold("Template")} ${chalk.dim(`(chat, ${template.length} message(s))`)}`);
    for (const m of template) {
      const nameSuffix = m.name !== undefined ? chalk.dim(` name=${m.name}`) : "";
      lines.push(`    ${chalk.cyan(`<${m.role}>`)}${nameSuffix}`);
      for (const contentLine of m.content.split("\n")) {
        lines.push(`      ${contentLine}`);
      }
    }
  } else {
    lines.push(`  ${chalk.bold("Template")} ${chalk.dim("(completion string)")}`);
    for (const contentLine of template.split("\n")) {
      lines.push(`    ${contentLine}`);
    }
  }
  const vars = extractTemplateVariables(template);
  if (vars.length > 0) {
    lines.push(`  ${chalk.bold("Variables")} ${chalk.dim(vars.map((v) => `{{${v}}}`).join(" "))}`);
  }
  return lines;
}

function describeConfig(config: PromptConfig): string[] {
  const rows: Array<[string, unknown]> = [
    ["model", config.model],
    ["provider", config.provider],
    ["endpoint", config.endpoint],
    ["maxTokens", config.maxTokens],
    ["temperature", config.temperature],
    ["topP", config.topP],
    ["stop", config.stop],
    ["presencePenalty", config.presencePenalty],
    ["frequencyPenalty", config.frequencyPenalty],
    ["seed", config.seed],
    ["reasoningEffort", config.reasoningEffort],
    ["responseFormat", config.responseFormat],
    ["tools", config.tools ? `${config.tools.length} tool(s)` : undefined],
    ["linkedTools", config.linkedTools],
  ];
  const lines: string[] = [`  ${chalk.bold("Config")}`];
  for (const [key, value] of rows) {
    if (value === undefined) continue;
    const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
    lines.push(`    ${chalk.dim(key.padEnd(17))}${rendered}`);
  }
  return lines;
}

/* ─── Command registration ────────────────────────────────────────────*/

export function registerPrompt(program: Command): void {
  const prompt = program
    .command("prompt")
    .description("Manage first-class typed prompt versions (.prompt config + template)");

  // ── prompt push ──
  prompt
    .command("push")
    .description("Import a .prompt file as a new local prompt version")
    .requiredOption("-f, --file <path>", "Path to a .prompt file")
    .option("-n, --name <name>", "Prompt name (defaults to the file's base name)")
    .option("--by <author>", "Author recorded on the version", "cli")
    .option("--dir <path>", "Prompt store directory (defaults to ~/.evalguard/prompts)")
    .action(
      async (opts: { file: string; name?: string; by: string; dir?: string }) => {
        const filePath = path.resolve(opts.file);
        if (!fs.existsSync(filePath)) {
          console.error(chalk.red(`File not found: ${filePath}`));
          process.exit(1);
        }
        const name = opts.name ?? path.basename(filePath).replace(/\.prompt$/i, "");
        let text: string;
        try {
          text = fs.readFileSync(filePath, "utf-8");
        } catch (err) {
          console.error(chalk.red(`Failed to read file: ${(err as Error).message}`));
          process.exit(1);
        }

        const store = createPromptStore(opts.dir);
        let saved: PromptVersion;
        try {
          saved = await pushPromptFile({ store, name, promptFileText: text, createdBy: opts.by });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        console.log();
        console.log(
          `  ${chalk.green("✓")} Pushed ${chalk.cyan(name)} ${chalk.bold(`v${saved.version}`)} ${chalk.dim(`(model: ${saved.config?.model})`)}`,
        );
        console.log(chalk.dim(`  Export it again with: evalguard prompt pull ${name} --version ${saved.version}`));
        console.log();
      },
    );

  // ── prompt pull ──
  prompt
    .command("pull")
    .description("Export a stored prompt version to the .prompt format")
    .argument("<name>", "Prompt name")
    .option("-v, --version <n>", "Version number (defaults to the latest)")
    .option("-o, --output <path>", "Write to a file instead of stdout")
    .option("--dir <path>", "Prompt store directory (defaults to ~/.evalguard/prompts)")
    .action(
      async (name: string, opts: { version?: string; output?: string; dir?: string }) => {
        const version = opts.version !== undefined ? Number(opts.version) : undefined;
        if (version !== undefined && !Number.isInteger(version)) {
          console.error(chalk.red(`--version must be an integer (got "${opts.version}")`));
          process.exit(1);
        }
        const store = createPromptStore(opts.dir);
        let text: string;
        try {
          text = await pullPromptFile({ store, name, version });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        if (opts.output) {
          const outPath = path.resolve(opts.output);
          fs.writeFileSync(outPath, text, "utf-8");
          console.error(chalk.green(`✓ Wrote ${outPath}`));
        } else {
          // Raw .prompt to stdout so `prompt pull … > x.prompt` is clean.
          process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
        }
      },
    );

  // ── prompt create ──
  prompt
    .command("create")
    .description("Create a new prompt version from typed --flags")
    .argument("<name>", "Prompt name")
    .requiredOption("-m, --model <model>", "Model instance, e.g. gpt-4o (required)")
    .option("-p, --provider <provider>", `Model provider (${MODEL_PROVIDER_VALUES.join("|")})`)
    .option("-e, --endpoint <endpoint>", `Model endpoint (${MODEL_ENDPOINT_VALUES.join("|")})`)
    .option("-t, --temperature <n>", "Sampling temperature")
    .option("--max-tokens <n>", "Max tokens to generate (-1 = dynamic)")
    .option("--top-p <n>", "Nucleus sampling mass (0..1)")
    .option("--seed <n>", "Deterministic sampling seed")
    .option("--presence-penalty <n>", "Presence penalty (-2..2)")
    .option("--frequency-penalty <n>", "Frequency penalty (-2..2)")
    .option("--reasoning-effort <v>", `Reasoning effort (${OPENAI_REASONING_EFFORT_VALUES.join("|")}|<int budget>)`)
    .option("--response-format <type>", `Response format (${RESPONSE_FORMAT_TYPE_VALUES.join("|")})`)
    .option("--stop <s>", "Stop sequence (repeatable)", (val: string, acc: string[] = []) => [...acc, val])
    .option("--template <text>", "Completion-string template")
    .option("--template-file <path>", "Read the template from a file")
    .option("--template-language <lang>", `Template language (${TEMPLATE_LANGUAGE_VALUES.join("|")})`)
    .option("--by <author>", "Author recorded on the version", "cli")
    .option("--dir <path>", "Prompt store directory (defaults to ~/.evalguard/prompts)")
    .action(
      async (
        name: string,
        opts: CreateFlags & {
          template?: string;
          templateFile?: string;
          templateLanguage?: string;
          by: string;
          dir?: string;
        },
      ) => {
        let config: PromptConfig;
        try {
          config = buildConfigFromFlags(opts);
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        let template: PromptTemplate | undefined;
        if (opts.template !== undefined && opts.templateFile !== undefined) {
          console.error(chalk.red("  Use only one of --template or --template-file"));
          process.exit(1);
        }
        if (opts.templateFile !== undefined) {
          const tPath = path.resolve(opts.templateFile);
          if (!fs.existsSync(tPath)) {
            console.error(chalk.red(`Template file not found: ${tPath}`));
            process.exit(1);
          }
          template = fs.readFileSync(tPath, "utf-8");
        } else if (opts.template !== undefined) {
          template = opts.template;
        }

        const file: PromptFile = { config };
        if (template !== undefined) file.template = template;
        if (opts.templateLanguage !== undefined) {
          file.templateLanguage = opts.templateLanguage as TemplateLanguage;
        }

        const store = createPromptStore(opts.dir);
        const version = await nextVersionNumber(store, name);
        const built = buildVersionFromPromptFile(file, name, version, opts.by);
        await store.save(name, built);

        console.log();
        console.log(
          `  ${chalk.green("✓")} Created ${chalk.cyan(name)} ${chalk.bold(`v${built.version}`)} ${chalk.dim(`(model: ${config.model})`)}`,
        );
        console.log(chalk.dim(`  Inspect it with: evalguard prompt show ${name} --version ${built.version}`));
        console.log();
      },
    );

  // ── prompt show ──
  prompt
    .command("show")
    .description("Show a stored prompt version's typed config + template")
    .argument("<name>", "Prompt name")
    .option("-v, --version <n>", "Version number (defaults to the latest)")
    .option("--json", "Print the raw version as JSON")
    .option("--dir <path>", "Prompt store directory (defaults to ~/.evalguard/prompts)")
    .action(
      async (name: string, opts: { version?: string; json?: boolean; dir?: string }) => {
        const version = opts.version !== undefined ? Number(opts.version) : undefined;
        if (version !== undefined && !Number.isInteger(version)) {
          console.error(chalk.red(`--version must be an integer (got "${opts.version}")`));
          process.exit(1);
        }
        const store = createPromptStore(opts.dir);
        const v =
          version !== undefined
            ? await store.getVersion(name, version)
            : await store.getLatest(name);
        if (!v) {
          console.error(
            chalk.red(
              version !== undefined
                ? `  Prompt "${name}" version ${version} not found`
                : `  Prompt "${name}" not found`,
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
          `  ${chalk.bold.cyan(v.name)} ${chalk.bold(`v${v.version}`)} ${chalk.dim(`· ${v.status} · by ${v.createdBy}`)}`,
        );
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
        if (v.config) {
          for (const line of describeConfig(v.config)) console.log(line);
        } else {
          console.log(chalk.yellow("  (legacy content-only version — no typed config)"));
          console.log(`  ${chalk.bold("Content")}`);
          for (const line of v.content.split("\n")) console.log(`    ${line}`);
        }
        if (v.config) {
          for (const line of describeTemplate(v.template)) console.log(line);
          if (v.templateLanguage !== undefined) {
            console.log(`  ${chalk.bold("Language")} ${chalk.dim(v.templateLanguage)}`);
          }
        }
        console.log();
      },
    );

  // ── prompt list ──
  prompt
    .command("list")
    .description("List locally-stored prompts and their latest version")
    .option("--dir <path>", "Prompt store directory (defaults to ~/.evalguard/prompts)")
    .action(async (opts: { dir?: string }) => {
      const store = createPromptStore(opts.dir);
      const names = await store.listPrompts();
      if (names.length === 0) {
        console.log(chalk.dim("  No prompts stored yet. Create one with `evalguard prompt create` or `prompt push`."));
        return;
      }
      console.log();
      console.log(`  ${chalk.bold("Prompts")} ${chalk.dim(`(${names.length})`)}`);
      for (const name of names.sort()) {
        const versions = await store.getVersions(name);
        const latest = versions[versions.length - 1];
        const model = latest?.config?.model ?? latest?.metadata.model ?? "—";
        const typed = latest?.config ? chalk.green("typed") : chalk.dim("content-only");
        console.log(
          `    ${chalk.cyan(name.padEnd(28))}${chalk.dim(`v${latest?.version ?? "?"}`).padEnd(14)}${chalk.dim(String(model)).padEnd(24)}${typed}`,
        );
      }
      console.log();
    });

  // ── prompt deploy ──
  prompt
    .command("deploy")
    .description("Deploy a stored prompt version to a named environment")
    .argument("<name>", "Prompt name")
    .requiredOption("-e, --env <name>", "Target environment (must be registered; see `evalguard env`)")
    .option("-v, --version <n>", "Version number (defaults to the latest)")
    .option("--by <author>", "Author recorded on the deployment", "cli")
    .option("--dir <path>", "Prompt store directory (defaults to ~/.evalguard/prompts)")
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
        const store = createPromptStore(opts.dir);
        const environments = await loadEnvironments(opts.environmentsFile);
        const deployLog = new DeployLog(opts.deploymentsFile);

        let record: DeploymentRecord;
        try {
          record = await deployPrompt({
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
