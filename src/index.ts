#!/usr/bin/env node
// Commands include the agent-builder groups: `agent-tools` (REST/code/MCP tool
// management + test) and `abuse-report` (file/list abuse reports). See PR #579.
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import {
  registerInit,
  registerInvestigate,
  registerSetup,
  registerEvalLocal,
  registerScanLocal,
  registerGenerate,
  registerValidate,
  registerCompare,
  registerList,
  registerFirewall,
  registerWatch,
  registerGate,
  registerHistory,
  registerComplianceCheck,
  registerAgentRules,
  registerIntent,
  registerImportPromptfoo,
  registerImportTraces,
  registerImportHumanloop,
  registerShare,
  registerExport,
  registerVulnLookup,
  registerRetry,
  registerScorecard,
  registerDebug,
  registerLogs,
  registerDelete,
  registerModelScan,
  registerCodeScan,
  registerView,
  registerCache,
  registerGenerateDataset,
  registerOptimize,
  registerBenchmark,
  registerDetectorEval,
  registerKeys,
  registerBudget,
  registerPricing,
  registerAgentRuns,
  registerShadowAI,
  registerSiem,
  registerModelsPromote,
  registerDatasets,
  registerRedTeam,
  registerRag,
  registerMcp,
  registerGrpc,
  registerFineTune,
  registerClickhouse,
  registerAiBom,
  registerInfra,
  registerRepoScan,
  registerEvaluators,
  registerCostExport,
  registerDecisionBom,
  registerRagAutoML,
  registerGatewayConfig,
  registerAgentTools,
  registerAbuseReport,
  registerGuardrailShadow,
  registerRegressionTrigger,
  registerAgentMemory,
  registerVoice,
  registerModeration,
  registerLanguage,
  registerGovernanceRisk,
  registerFirewallFairnessReport,
  registerVulnWaiver,
  registerConsensus,
  registerSbomMonitor,
  registerIncidentRca,
  registerDataBoundary,
  registerIssueSync,
  registerIacScan,
  registerSecretScan,
  registerServerRead,
  buildEvalLocalArgs,
} from "./commands/index.js";
import { isLoopbackUrl, maskApiKey, normalizeBaseUrl, resolveProjectId } from "./lib/config.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const CONFIG_DIR = path.join(os.homedir(), ".evalguard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// SECURITY WARNING: API key is stored in plaintext at ~/.evalguard/config.json
// (mode 0o600). For production use, consider integrating an OS keyring
// (e.g., keytar, @aspect/credentials) or using environment variables instead.

/**
 * Validates that a resolved file path is within the current working directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 */
function assertPathWithinCwd(filePath: string): string {
  const resolved = path.resolve(filePath);
  // Resolve symlinks to prevent symlink-based traversal attacks
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    canonical = resolved; // File may not exist yet (e.g., output paths)
  }
  const cwd = fs.realpathSync(process.cwd());
  if (!canonical.startsWith(cwd + path.sep) && canonical !== cwd) {
    throw new Error(`Security error: Path "${filePath}" resolves outside the current working directory.`);
  }
  return canonical;
}

interface CLIConfig {
  apiKey?: string;
  baseUrl?: string;
  projectId?: string;
}

function loadConfig(): CLIConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as CLIConfig;
    }
  } catch (err) {
    console.warn(`Warning: Failed to load config from ${CONFIG_FILE}: ${(err as Error).message}`);
  }
  return {};
}

function saveConfig(config: CLIConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Parse `N.N.N` (ignoring -prerelease/+build) → [major, minor, patch]. */
function parseCliSemver(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpCliSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Pull a human-readable message out of an API error body, regardless of which
 * envelope shape the server used. The standard EvalGuard error envelope is
 * `{ success: false, error: { message, code } }`; validation failures fold the
 * Zod field errors into `error.message` ("field: msg; field: msg"). We also
 * tolerate a flat `{ message }`, a bare `{ error: "string" }`, and a top-level
 * `fieldErrors`/`errors` map so users see the real reason instead of the
 * useless "Unknown error" (audit: cli-error-masking-unknown-error).
 */
function extractServerError(data: unknown, fallback: string): string {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const err = obj.error;
    if (typeof err === "string" && err.trim()) return err;
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
    // Field-level validation errors (e.g. `{ fieldErrors: { name: ["Required"] } }`).
    const fieldErrors = (obj.fieldErrors ?? obj.errors) as
      | Record<string, unknown>
      | undefined;
    if (fieldErrors && typeof fieldErrors === "object") {
      const parts = Object.entries(fieldErrors)
        .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`)
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    }
  }
  return fallback || "Unknown error";
}

function getClient() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error(chalk.red("Not authenticated. Run `evalguard login` first."));
    process.exit(1);
  }
  // Dynamic import not needed — use fetch directly
  const baseUrl = config.baseUrl ?? "https://evalguard.ai/api/v1";
  return {
    apiKey: config.apiKey,
    baseUrl,
    projectId: config.projectId,
    async request(urlPath: string, method: string, body?: unknown) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          // Report the CLI version so an org that pins an allowed client version
          // range (enterprise-managed governance policy) can enforce it server-side.
          "x-evalguard-client-version": pkg.version,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await res.json().catch(() => ({ message: res.statusText }));
      if (!res.ok) {
        throw new Error(`API error ${res.status}: ${extractServerError(data, res.statusText)}`);
      }
      return data;
    },
    /**
     * Consult the org's enterprise-managed client version-pinning policy and
     * HARD-STOP (process.exit 1) when this CLI version is outside the approved
     * range. Unpinned orgs / unreachable endpoint / older servers = allowed
     * (fail-open: a transient policy blip must not brick the whole CLI fleet —
     * the server also sees the version header on every request).
     */
    async assertVersionAllowed() {
      let policy: { requiredMinimumVersion?: string | null; requiredMaximumVersion?: string | null };
      try {
        const raw = (await this.request(
          `/client/policy?version=${encodeURIComponent(pkg.version)}`,
          "GET",
        )) as { data?: unknown } | Record<string, unknown>;
        // Unwrap the { success, data } envelope when present.
        policy = ((raw as { data?: unknown }).data ?? raw) as {
          requiredMinimumVersion?: string | null;
          requiredMaximumVersion?: string | null;
        };
      } catch {
        return; // unreachable / older server → treat as unpinned
      }

      const min = policy.requiredMinimumVersion ?? null;
      const max = policy.requiredMaximumVersion ?? null;
      if (!min && !max) return; // unpinned

      const ver = parseCliSemver(pkg.version);
      const minT = parseCliSemver(min);
      const maxT = parseCliSemver(max);
      if (ver && minT && cmpCliSemver(ver, minT) < 0) {
        console.error(
          chalk.red(
            `EvalGuard CLI ${pkg.version} is below the minimum version (${min}) required by this organization. Upgrade with \`npm i -g @evalguard/cli\`.`,
          ),
        );
        process.exit(1);
      }
      if (ver && maxT && cmpCliSemver(ver, maxT) > 0) {
        console.error(
          chalk.red(
            `EvalGuard CLI ${pkg.version} is above the maximum version (${max}) allowed by this organization. Install a supported release.`,
          ),
        );
        process.exit(1);
      }
    },
  };
}

// ─── Eval config file types ───
interface EvalConfigFile {
  name: string;
  projectId?: string;
  model: string;
  prompt: string;
  scorers: string[];
  cases: { input: string; expectedOutput?: string }[];
}

interface ScanConfigFile {
  projectId?: string;
  model: string;
  prompt: string;
  // Legacy flat shape (`attackTypes:`) and the `init -t security-scan`
  // template shape (`redteam: { plugins: [...] }`) are both accepted.
  attackTypes?: string[];
  redteam?: { plugins?: string[] };
}

// ─── Program ───
const program = new Command();

program
  .name("evalguard")
  .description(
    chalk.bold("EvalGuard CLI") +
      " — The Operating System for AI Quality"
  )
  .version(pkg.version);

// ─── login ───
program
  .command("login")
  .description("Authenticate with your EvalGuard API key")
  .option("--key <apiKey>", "API key (or set EVALGUARD_API_KEY env var)")
  .option("--url <baseUrl>", "Custom API base URL")
  .action((opts: { key?: string; url?: string }) => {
    const apiKey = opts.key ?? process.env.EVALGUARD_API_KEY;
    if (!apiKey) {
      console.error(
        chalk.red(
          "Provide an API key via --key or EVALGUARD_API_KEY environment variable."
        )
      );
      console.log(
        chalk.dim("  Get your API key at https://evalguard.ai/dashboard/settings")
      );
      process.exit(1);
    }

    const config = loadConfig();
    config.apiKey = apiKey;
    if (opts.url) {
      let parsed: URL;
      try {
        parsed = new URL(opts.url);
      } catch {
        console.error('Error: Invalid URL format');
        process.exit(1);
      }
      // Allow plaintext ONLY for loopback hosts (local dev). Comparing the
      // parsed hostname — not a substring of the raw URL — closes the
      // `?x=localhost` bypass that leaked the key in cleartext to remote hosts.
      if (parsed!.protocol !== 'https:' && !isLoopbackUrl(opts.url)) {
        console.error('Error: Base URL must use HTTPS for security. Use --url https://...');
        process.exit(1);
      }
      // Persist the versioned API root. `--url https://evalguard.ai` (no
      // /api/v1, or with a trailing slash) otherwise 404s every authenticated
      // subcommand that reads config.baseUrl directly (audit:
      // cli-login-base-url-missing-api-v1).
      config.baseUrl = normalizeBaseUrl(opts.url);
    }
    saveConfig(config);

    console.log(chalk.green("✓") + " Authenticated successfully.");
    console.log(chalk.dim(`  Config saved to ${CONFIG_FILE}`));
  });

// ─── logout ───
program
  .command("logout")
  .description("Remove stored credentials")
  .action(() => {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
    console.log(chalk.green("✓") + " Logged out.");
  });

// ─── init (registered from commands/init.ts) ───
registerInit(program);
registerSetup(program);
// ─── investigate — OpenSRE-style one-shot triage on a single
//                   AI-safety event (OTLP span / firewall block / LLM output).
registerInvestigate(program);
registerAgentRules(program);
registerIntent(program);

// ─── eval ───
program
  .command("eval")
  .description("Run an evaluation from a config file")
  .argument("[file]", "Path to eval config JSON/YAML file (default: evalguard.yaml)")
  .option(
    "--project <projectId>",
    "Project ID (defaults to your org's current project when omitted)",
  )
  .option("--model <model>", "Override model")
  .option("--wait", "Wait for completion and show results", false)
  .option("--local", "Run locally without API key (uses eval:local)", false)
  // These flags only apply to the local path (--local / a .yaml file) where we
  // delegate to `eval:local`. Declaring them here lets `evalguard eval --local
  // --verbose` parse (Commander otherwise errored "unknown option '--verbose'")
  // and lets us forward them through to the eval:local sub-command.
  .option("--provider <provider>", "Override provider (local runs only: openai, anthropic, echo, …)")
  .option("--output <format>", "Output format for local runs: json, csv, html, human-eval, junit, or file path")
  .option("--verbose", "Show detailed output per test case (local runs only)", false)
  .option("--no-cache", "Disable eval response caching (local runs only)")
  .action(
    async (
      fileArg: string | undefined,
      opts: {
        project?: string;
        model?: string;
        wait?: boolean;
        local?: boolean;
        provider?: string;
        output?: string;
        verbose?: boolean;
        cache?: boolean;
      }
    ) => {
      // Auto-detect evalguard.yaml if no file specified
      let file = fileArg ?? "";
      if (!file) {
        const yamlPath = path.join(process.cwd(), "evalguard.yaml");
        const ymlPath = path.join(process.cwd(), "evalguard.yml");
        const jsonPath = path.join(process.cwd(), "evalguard.config.json");
        if (fs.existsSync(yamlPath)) {
          file = yamlPath;
        } else if (fs.existsSync(ymlPath)) {
          file = ymlPath;
        } else if (fs.existsSync(jsonPath)) {
          file = jsonPath;
        } else {
          console.log(chalk.red("No evalguard.yaml found in current directory."));
          console.log(chalk.dim("  Run `npx evalguard init` to create one."));
          process.exit(1);
        }
        console.log(chalk.dim(`  Using ${path.basename(file)}`));
      }

      // Delegate to eval:local for --local flag or YAML files. Forward every
      // flag eval:local understands so the documented quickstart
      // `evalguard eval --local --verbose` (and --provider/--model/--output/
      // --no-cache) behaves identically to calling `eval:local` directly.
      if (opts.local || file.endsWith(".yaml") || file.endsWith(".yml")) {
        const evalLocalArgs = buildEvalLocalArgs(file, opts);
        // Re-dispatch to eval:local
        await program.parseAsync(["node", "evalguard", "eval:local", ...evalLocalArgs]);
        return;
      }
      const spinner = ora("Reading eval config...").start();

      try {
        const filePath = assertPathWithinCwd(file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(`File not found: ${filePath}`);
          process.exit(1);
        }

        const config = JSON.parse(
          fs.readFileSync(filePath, "utf-8")
        ) as EvalConfigFile;
        const client = getClient();
        // An explicit --project (or a projectId in the config file / login
        // config) always wins and skips the network call. When none is
        // supplied, auto-resolve the org's current project via
        // /project/current (cached per process). Errors clearly if empty.
        const explicitProjectId =
          opts.project ?? config.projectId ?? client.projectId;
        let projectId: string;
        try {
          projectId = await resolveProjectId(explicitProjectId);
        } catch (resolveErr) {
          spinner.fail(
            resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          );
          process.exit(1);
        }

        spinner.text = `Running eval "${config.name}" with ${config.cases.length} cases...`;

        const result = await client.request("/evals", "POST", {
          projectId,
          name: config.name,
          model: opts.model ?? config.model,
          prompt: config.prompt,
          scorers: config.scorers,
          cases: config.cases,
        });

        const data = result as Record<string, unknown>;
        const evalData = (data.data ?? data) as Record<string, unknown>;
        spinner.succeed(
          `Eval created: ${chalk.cyan(evalData.id as string)}`
        );
        console.log(
          chalk.dim(`  Status: ${evalData.status as string}`)
        );

        if (opts.wait && evalData.id) {
          const pollSpinner = ora("Waiting for results...").start();
          let attempts = 0;
          while (attempts < 60) {
            await new Promise((r) => setTimeout(r, 2000));
            const poll = (await client.request(
              `/evals/${evalData.id as string}`,
              "GET"
            )) as Record<string, unknown>;
            const pollData = (poll.data ?? poll) as Record<
              string,
              unknown
            >;
            const status = pollData.status as string;

            if (
              status === "passed" ||
              status === "failed" ||
              status === "error"
            ) {
              pollSpinner.stop();
              const scoreStr =
                pollData.score != null
                  ? `${pollData.score}/${pollData.max_score}`
                  : "N/A";
              const color = status === "passed" ? chalk.green : chalk.red;
              console.log(
                `\n  ${color("●")} ${chalk.bold(status.toUpperCase())}  Score: ${chalk.bold(scoreStr)}`
              );
              break;
            }
            attempts++;
          }
          if (attempts >= 60) {
            pollSpinner.warn("Timed out waiting for results.");
          }
        }
      } catch (err) {
        spinner.fail(
          `Eval failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    }
  );

// ─── scan ───
program
  .command("scan")
  .description("Run a security scan from a config file")
  .argument("<file>", "Path to scan config JSON file")
  .option(
    "--project <projectId>",
    "Project ID (defaults to your org's current project when omitted)",
  )
  .option("--model <model>", "Override model")
  .option("--wait", "Wait for completion and show results", false)
  .action(
    async (
      file: string,
      opts: { project?: string; model?: string; wait?: boolean }
    ) => {
      const spinner = ora("Reading scan config...").start();

      try {
        const filePath = assertPathWithinCwd(file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(`File not found: ${filePath}`);
          process.exit(1);
        }

        const config = JSON.parse(
          fs.readFileSync(filePath, "utf-8")
        ) as ScanConfigFile;
        const client = getClient();
        // Explicit --project (or config-file / login projectId) wins and skips
        // the network call; otherwise auto-resolve via /project/current.
        const explicitProjectId =
          opts.project ?? config.projectId ?? client.projectId;
        let projectId: string;
        try {
          projectId = await resolveProjectId(explicitProjectId);
        } catch (resolveErr) {
          spinner.fail(
            resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          );
          process.exit(1);
        }

        // Accept the `init -t security-scan` template (redteam.plugins) and the
        // legacy flat `attackTypes:` shape. Never read `.length` off an
        // undefined field — emit a graceful validation error instead.
        const attackTypes = config.redteam?.plugins ?? config.attackTypes;
        if (!Array.isArray(attackTypes) || attackTypes.length === 0) {
          spinner.fail(
            "Invalid scan config: expected 'redteam.plugins' or 'attackTypes' to be a non-empty array.",
          );
          process.exit(1);
        }

        spinner.text = `Scanning ${attackTypes.length} attack types against ${opts.model ?? config.model}...`;

        const result = await client.request("/security", "POST", {
          projectId,
          model: opts.model ?? config.model,
          prompt: config.prompt,
          attackTypes,
        });

        const data = result as Record<string, unknown>;
        const scanData = (data.data ?? data) as Record<string, unknown>;
        spinner.succeed(
          `Scan created: ${chalk.cyan(scanData.id as string)}`
        );
        console.log(
          chalk.dim(`  Status: ${scanData.status as string}`)
        );

        if (opts.wait && scanData.id) {
          const pollSpinner = ora("Waiting for results...").start();
          let attempts = 0;
          while (attempts < 60) {
            await new Promise((r) => setTimeout(r, 2000));
            const poll = (await client.request(
              `/security/${scanData.id as string}`,
              "GET"
            )) as Record<string, unknown>;
            const pollData = (poll.data ?? poll) as Record<
              string,
              unknown
            >;
            const status = pollData.status as string;

            if (
              status === "passed" ||
              status === "failed" ||
              status === "error"
            ) {
              pollSpinner.stop();
              const color = status === "passed" ? chalk.green : chalk.red;
              console.log(
                `\n  ${color("●")} ${chalk.bold(status.toUpperCase())}`
              );
              if (
                pollData.security_score != null
              ) {
                console.log(
                  `  Security Score: ${chalk.bold(String(pollData.security_score))}%`
                );
              }
              break;
            }
            attempts++;
          }
          if (attempts >= 60) {
            pollSpinner.warn("Timed out waiting for results.");
          }
        }
      } catch (err) {
        spinner.fail(
          `Scan failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    }
  );

// ─── whoami ───
program
  .command("whoami")
  .description("Show current authentication status")
  .action(() => {
    const config = loadConfig();
    if (config.apiKey) {
      const masked = maskApiKey(config.apiKey);
      console.log(chalk.green("✓") + " Authenticated");
      console.log(chalk.dim(`  API Key: ${masked}`));
      console.log(
        chalk.dim(
          `  Base URL: ${config.baseUrl ?? "https://evalguard.ai/api/v1"}`
        )
      );
      if (config.projectId) {
        console.log(chalk.dim(`  Project: ${config.projectId}`));
      }
    } else {
      console.log(chalk.yellow("Not authenticated."));
      console.log(chalk.dim("  Run `evalguard login --key <your-api-key>`"));
    }
  });

// ─── Phase 6: New Commands ───
registerEvalLocal(program);
registerScanLocal(program);
registerGenerate(program);
registerValidate(program);
registerCompare(program);
registerList(program);
registerFirewall(program);
registerWatch(program);
registerGate(program);
registerHistory(program);
registerComplianceCheck(program);
registerImportPromptfoo(program);
registerImportTraces(program);
registerImportHumanloop(program);
registerShare(program);
registerExport(program);
registerVulnLookup(program);
registerRetry(program);
registerScorecard(program);
registerDebug(program);
registerLogs(program);
registerDelete(program);
registerModelScan(program);
registerCodeScan(program);
registerView(program);
registerCache(program);
registerGenerateDataset(program);
registerOptimize(program);
registerBenchmark(program);
registerDetectorEval(program);
registerKeys(program);
registerBudget(program);
registerPricing(program);
registerAgentRuns(program);
registerShadowAI(program);
registerSiem(program);
registerModelsPromote(program);
registerDatasets(program);
registerRedTeam(program);
registerRag(program);
registerMcp(program);
registerGrpc(program);
registerFineTune(program);
registerClickhouse(program);
registerAiBom(program);
registerInfra(program);
registerRepoScan(program);
registerEvaluators(program);
registerCostExport(program);
registerDecisionBom(program);
registerRagAutoML(program);
registerGatewayConfig(program);
registerAgentTools(program);
registerAbuseReport(program);
registerGuardrailShadow(program);
registerRegressionTrigger(program);
registerAgentMemory(program);
registerVoice(program);
registerModeration(program);
registerLanguage(program);
registerGovernanceRisk(program);
registerFirewallFairnessReport(program);
registerVulnWaiver(program);
registerConsensus(program);
registerSbomMonitor(program);
registerIncidentRca(program);
registerDataBoundary(program);
registerIssueSync(program);
registerIacScan(program);
registerSecretScan(program);
registerServerRead(program);

/**
 * Print a clean one-line error for the user instead of a raw Node stack trace.
 * Commander's own usage errors (unknown command / missing argument) carry a
 * numeric `exitCode` and have already been reported by Commander, so we just
 * propagate their exit code without re-printing (audit: cli-raw-stack-traces).
 */
function reportFatal(err: unknown): never {
  const code = (err as { exitCode?: unknown })?.exitCode;
  if (typeof code === "number") {
    // Commander already wrote its own message; honor its exit code.
    process.exit(code);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

// A handler that throws after the event loop has drained (e.g. a rejected
// fetch in an async action) surfaces here rather than as a raw stack dump.
process.on("unhandledRejection", reportFatal);

program.parseAsync().catch(reportFatal);
