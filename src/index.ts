#!/usr/bin/env node
// Commands include the agent-builder groups: `agent-tools` (REST/code/MCP tool
// management + test) and `abuse-report` (file/list abuse reports). See PR #579.
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
// `os` was imported only to build the ~/.evalguard path; that now lives in
// ./lib/config.ts (configFilePath), which is the single owner of the config
// location, the profile layout and every read/write of it.
import { createRequire } from "module";
import { checkPathContained, isWithinPath } from "@evalguard/core/security/path-containment";
import {
  registerInit,
  registerProfile,
  registerInvestigate,
  registerSetup,
  registerEvalLocal,
  registerScanLocal,
  registerGenerate,
  registerValidate,
  registerVerify,
  registerCompare,
  registerList,
  registerFirewall,
  registerMcpDiscover,
  registerWatch,
  registerGate,
  registerHistory,
  registerComplianceCheck,
  registerCertGap,
  registerAgentRules,
  registerIntent,
  registerImportPromptfoo,
  registerImportTraces,
  registerImportHumanloop,
  registerImportLangsmith,
  registerImportBraintrust,
  registerImportDeepeval,
  registerImportRagas,
  registerImportOpenaiEvals,
  registerImportGiskard,
  registerPrompt,
  registerEnv,
  registerTool,
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
  registerSkillScan,
  registerView,
  registerCache,
  registerGenerateDataset,
  registerOptimize,
  registerBenchmark,
  registerDetectorEval,
  registerAttackProof,
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
  registerGuardrail,
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
  registerWhoami,
  buildEvalLocalArgs,
} from "./commands/index.js";
import {
  activeProfileName,
  configFilePath,
  deleteProfile,
  getProfile,
  isLoopbackUrl,
  listProfileNames,
  loadConfigFile,
  normalizeBaseUrl,
  resolveBaseUrl,
  resolveProjectId,
  upsertProfile,
  type CLIConfig,
} from "./lib/config.js";
import { isProtectedSecret, purgeSecret } from "./lib/secret-store.js";
import {
  readEvalPollResult,
  readScanPollResult,
  failSpinner,
  evalWaitExitCode,
  scanWaitExitCode,
} from "./lib/poll.js";
import { getCloudClient, validateApiKey } from "./lib/cloud-client.js";
import {
  ROOT_VALUE_OPTIONS,
  checkCommandPath,
  checkTopLevelCommand,
  type CommandNode,
} from "./lib/command-guard.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// SECURITY WARNING: API keys are stored in plaintext at ~/.evalguard/config.json
// (mode 0o600, in a 0o700 directory). For production use, consider integrating
// an OS keyring (e.g., keytar, @aspect/credentials) or using environment
// variables instead.
//
// The path, the profile layout and every read/write live in ./lib/config.ts —
// this file must not keep a second copy. It used to: a private CONFIG_FILE +
// loadConfig + saveConfig here wrote the FLAT shape while ~50 subcommands read
// through lib/config, so any change to the format silently applied to one half
// of the CLI (the "fix the reachable copy" failure mode).

/**
 * Validates that a resolved file path is within the current working directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 *
 * Uses the shared containment helper (audit 2026-07-25 wave 7) rather than its
 * own realpath + `startsWith`, so this guard gets the same two properties as the
 * MCP local-scan boundary: symlinks are resolved, AND a hard link is refused.
 * `fs.realpathSync` returns a HARD LINK's own path — the link is a second
 * directory entry for the same inode, not a pointer — so realpath alone let
 * `<cwd>/config.json` hard-linked to an out-of-cwd file pass, and this command
 * then read that file and uploaded it to the API. Leaf-module import keeps CLI
 * startup free of the full core barrel (same reason as gate.ts).
 */
function assertPathWithinCwd(filePath: string): string {
  const resolved = path.resolve(filePath);
  const cwd = fs.realpathSync(process.cwd());
  const contained = checkPathContained(cwd, resolved);
  if (contained.ok) return contained.canonicalPath ?? resolved;
  if (contained.verdict === "unresolvable") {
    // File may not exist yet (e.g. output paths). The lexical check still holds
    // and is the only one that can: there is nothing on disk to resolve.
    if (isWithinPath(cwd, resolved)) return resolved;
    throw new Error(`Security error: Path "${filePath}" resolves outside the current working directory.`);
  }
  if (contained.verdict === "multiply-linked") {
    throw new Error(`Security error: Path "${filePath}" is refused — ${contained.reason}.`);
  }
  throw new Error(`Security error: Path "${filePath}" resolves outside the current working directory.`);
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
  // Global profile selector: `evalguard --profile self-hosted runs list`.
  // Implemented by setting EVALGUARD_PROFILE for this process, which is the
  // SAME lever the env var uses, so there is exactly one precedence rule
  // (lib/config.ts#activeProfileName) rather than a second one that drifts.
  // Subcommands that also accept `--profile` (login) keep their own flag,
  // because commander only parses program-level options BEFORE the subcommand.
  .option(
    "--profile <name>",
    "Use a named profile for this invocation (see `evalguard profile list`)",
  )
  .version(pkg.version);

program.hook("preAction", (thisCommand) => {
  const selected = (thisCommand.opts() as { profile?: string }).profile?.trim();
  if (selected) process.env.EVALGUARD_PROFILE = selected;
});

// ─── login ───
program
  .command("login")
  .description("Authenticate with your EvalGuard API key")
  .option("--key <apiKey>", "API key (or set EVALGUARD_API_KEY env var)")
  .option("--url <baseUrl>", "Custom API base URL")
  .option(
    "--profile <name>",
    "Save into this named profile instead of the active one (and switch to it)",
  )
  .action(async (opts: { key?: string; url?: string; profile?: string }) => {
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

    // Which profile this login writes. `--profile` names one explicitly and
    // switches to it; otherwise the active profile is updated IN PLACE. Either
    // way only ONE profile is touched — `login` used to overwrite the entire
    // single-credential file, which is what made running two installs painful
    // (audit 2026-08-05: cli-no-named-profiles).
    const configFile = configFilePath();
    const fileBefore = loadConfigFile(configFile);
    const targetProfile = opts.profile?.trim() || activeProfileName(fileBefore);
    const config: CLIConfig = { ...(fileBefore.profiles[targetProfile] ?? {}) };
    config.apiKey = apiKey;
    // The base URL the resolved key will actually be used against: the
    // normalized `--url` value when supplied, otherwise the standard
    // env/config/default precedence.
    let baseUrlForCheck = resolveBaseUrl(config);
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
      baseUrlForCheck = config.baseUrl;
    }

    // Server-side validate the key BEFORE persisting it, so a bad key is
    // rejected here instead of being silently stored and only failing on the
    // first real command. Fail-OPEN on an unreachable/erroring server so
    // offline/air-gapped users aren't blocked (the key is re-checked on use).
    const validation = await validateApiKey(apiKey, baseUrlForCheck, pkg.version);
    if (validation.status === "invalid") {
      console.error(chalk.red("✗ " + validation.message));
      console.log(
        chalk.dim("  Get your API key at https://evalguard.ai/dashboard/settings")
      );
      process.exit(1);
    }
    if (validation.status === "unverified") {
      console.warn(
        chalk.yellow(
          `⚠ Could not verify the key (${validation.reason}); saving it anyway — it will be checked on first use.`
        )
      );
    }

    upsertProfile(targetProfile, config, {
      // An explicit --profile also switches; an implicit one is already active.
      switchTo: Boolean(opts.profile?.trim()),
      file: configFile,
    });

    console.log(chalk.green("✓") + " Authenticated successfully.");
    console.log(
      chalk.dim(`  Saved to profile ${chalk.cyan(targetProfile)} in ${configFile}`),
    );
    const others = listProfileNames(loadConfigFile(configFile)).filter((n) => n !== targetProfile);
    if (others.length > 0) {
      console.log(chalk.dim(`  Other profiles left untouched: ${others.join(", ")}`));
    }
  });

// ─── logout ───
program
  .command("logout")
  .description("Remove stored credentials for the active profile")
  .option("--profile <name>", "Log out of this profile instead of the active one")
  .option("--all", "Delete the whole config file, every profile included", false)
  .action((opts: { profile?: string; all: boolean }) => {
    const configFile = configFilePath();

    // Deleting the config file is NOT enough now that secrets can live outside
    // it. On macOS/Linux the file holds only a lookup reference and the key
    // itself sits in the Keychain / Secret Service, so unlinking the file
    // leaves the credential behind — a "logout" that does not log you out, and
    // an orphan nobody will ever garbage-collect. Purge first, then unlink.
    // (DPAPI needs no purge: its ciphertext IS the file being removed.)
    const purgeAll = (): void => {
      let stored;
      try {
        stored = loadConfigFile(configFile);
      } catch {
        return; // unreadable config — nothing we can resolve to purge
      }
      for (const name of listProfileNames(stored)) {
        const profile = getProfile(name, stored);
        if (isProtectedSecret(profile.apiKeyEnc)) purgeSecret(profile.apiKeyEnc);
      }
    };

    // `--all` keeps the historical behaviour exactly: the file goes away.
    if (opts.all) {
      if (fs.existsSync(configFile)) {
        purgeAll();
        fs.unlinkSync(configFile);
      }
      console.log(chalk.green("✓") + " Logged out of every profile (config file removed).");
      return;
    }

    const config = loadConfigFile(configFile);
    const target = opts.profile?.trim() || activeProfileName(config);
    const names = listProfileNames(config);

    if (!Object.prototype.hasOwnProperty.call(config.profiles, target)) {
      console.log(chalk.green("✓") + " Logged out.");
      return;
    }

    // One profile and nothing else stored? Remove the file, so `logout` on a
    // single-install setup behaves exactly as it always has — but purge the
    // keyring entry first, for the same reason as `--all` above.
    if (names.length <= 1) {
      if (fs.existsSync(configFile)) {
        purgeAll();
        fs.unlinkSync(configFile);
      }
      console.log(chalk.green("✓") + " Logged out.");
      return;
    }

    deleteProfile(target, configFile);
    console.log(chalk.green("✓") + ` Logged out of profile ${chalk.cyan(target)}.`);
    console.log(
      chalk.dim(
        `  Still saved: ${listProfileNames(loadConfigFile(configFile)).join(", ")}. ` +
          `Use \`evalguard logout --all\` to remove everything.`,
      ),
    );
  });

// ─── profile (named connection profiles: list/current/create/use/delete) ───
registerProfile(program);

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
          console.log(chalk.dim("  Run `npx @evalguard/cli init` to create one."));
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
          // Clean spinner stop + exitCode (never process.exit mid-spinner —
          // see failSpinner for the libuv-abort rationale).
          failSpinner(spinner, `File not found: ${filePath}`);
          return;
        }

        const config = JSON.parse(
          fs.readFileSync(filePath, "utf-8")
        ) as EvalConfigFile;
        const clientResult = getCloudClient(pkg.version);
        if (!clientResult.ok) {
          failSpinner(
            spinner,
            "Not authenticated. Run `evalguard login` first, or set EVALGUARD_API_KEY.",
          );
          return;
        }
        const client = clientResult.client;
        // ENTERPRISE CLIENT-VERSION PINNING — the only two call sites.
        //
        // `assertVersionAllowed()` shipped in lib/cloud-client.ts and was called
        // by nothing, so an org that pinned an allowed CLI range in
        // `gateway_managed_policy` got zero client-side enforcement. It is
        // wired here rather than deleted; see the method's doc comment for the
        // wire-or-delete reasoning and the fail-OPEN-on-transport /
        // fail-CLOSED-on-verdict decision.
        //
        // `failSpinner`, not `process.exit`: we are inside a live ora spinner
        // and have just made an HTTP request, which is exactly the state where
        // process.exit() trips the libuv UV_HANDLE_CLOSING abort on Windows.
        // A policy refusal must read as a refusal, not as exit 127.
        try {
          await client.assertVersionAllowed();
        } catch (policyErr) {
          failSpinner(
            spinner,
            policyErr instanceof Error ? policyErr.message : String(policyErr),
          );
          return;
        }
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
          failSpinner(
            spinner,
            resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          );
          return;
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
            // Read status/score tolerant of BOTH the flat `data.status` and the
            // nested `data.run.status` shapes — reading only `data.status` used
            // to spin to timeout against the nested backend response.
            const { status, score, maxScore } = readEvalPollResult(pollData);

            if (
              status === "passed" ||
              status === "failed" ||
              status === "error"
            ) {
              pollSpinner.stop();
              const scoreStr =
                score != null
                  ? `${score}/${maxScore ?? "?"}`
                  : "N/A";
              const color = status === "passed" ? chalk.green : chalk.red;
              console.log(
                `\n  ${color("●")} ${chalk.bold(status.toUpperCase())}  Score: ${chalk.bold(scoreStr)}`
              );
              // Fail-closed: a terminal `failed`/`error` status must fail the CI
              // build. Set process.exitCode (never process.exit mid-teardown —
              // see failSpinner) so `eval --wait` can gate a pipeline (audit C1).
              process.exitCode = evalWaitExitCode(status);
              break;
            }
            attempts++;
          }
          if (attempts >= 60) {
            pollSpinner.warn("Timed out waiting for results.");
            // A --wait that never resolved must NOT report success in CI.
            process.exitCode = 1;
          }
        }
      } catch (err) {
        // Clean spinner stop + exitCode 1; never process.exit() mid-spinner
        // (libuv UV_HANDLE_CLOSING abort / exit 127 on Windows Node).
        failSpinner(
          spinner,
          `Eval failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
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
          failSpinner(spinner, `File not found: ${filePath}`);
          return;
        }

        const config = JSON.parse(
          fs.readFileSync(filePath, "utf-8")
        ) as ScanConfigFile;
        const clientResult = getCloudClient(pkg.version);
        if (!clientResult.ok) {
          failSpinner(
            spinner,
            "Not authenticated. Run `evalguard login` first, or set EVALGUARD_API_KEY.",
          );
          return;
        }
        const client = clientResult.client;
        // ENTERPRISE CLIENT-VERSION PINNING — the only two call sites.
        //
        // `assertVersionAllowed()` shipped in lib/cloud-client.ts and was called
        // by nothing, so an org that pinned an allowed CLI range in
        // `gateway_managed_policy` got zero client-side enforcement. It is
        // wired here rather than deleted; see the method's doc comment for the
        // wire-or-delete reasoning and the fail-OPEN-on-transport /
        // fail-CLOSED-on-verdict decision.
        //
        // `failSpinner`, not `process.exit`: we are inside a live ora spinner
        // and have just made an HTTP request, which is exactly the state where
        // process.exit() trips the libuv UV_HANDLE_CLOSING abort on Windows.
        // A policy refusal must read as a refusal, not as exit 127.
        try {
          await client.assertVersionAllowed();
        } catch (policyErr) {
          failSpinner(
            spinner,
            policyErr instanceof Error ? policyErr.message : String(policyErr),
          );
          return;
        }
        // Explicit --project (or config-file / login projectId) wins and skips
        // the network call; otherwise auto-resolve via /project/current.
        const explicitProjectId =
          opts.project ?? config.projectId ?? client.projectId;
        let projectId: string;
        try {
          projectId = await resolveProjectId(explicitProjectId);
        } catch (resolveErr) {
          failSpinner(
            spinner,
            resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          );
          return;
        }

        // Accept the `init -t security-scan` template (redteam.plugins) and the
        // legacy flat `attackTypes:` shape. Never read `.length` off an
        // undefined field — emit a graceful validation error instead.
        const attackTypes = config.redteam?.plugins ?? config.attackTypes;
        if (!Array.isArray(attackTypes) || attackTypes.length === 0) {
          failSpinner(
            spinner,
            "Invalid scan config: expected 'redteam.plugins' or 'attackTypes' to be a non-empty array.",
          );
          return;
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
            // Tolerant of the nested `data.run.status` shape and of the score
            // living under `score`/`pass_rate` (current API) or the legacy
            // `security_score` field. `criticalCount` drives the fail-closed
            // exit so a scan with critical findings blocks the build.
            const { status, score, criticalCount } = readScanPollResult(pollData);

            if (
              status === "passed" ||
              status === "failed" ||
              status === "error"
            ) {
              pollSpinner.stop();
              const exitCode = scanWaitExitCode(status, criticalCount);
              const color = exitCode === 0 ? chalk.green : chalk.red;
              console.log(
                `\n  ${color("●")} ${chalk.bold(status.toUpperCase())}`
              );
              if (
                score != null
              ) {
                console.log(
                  `  Security Score: ${chalk.bold(String(score))}%`
                );
              }
              if (typeof criticalCount === "number" && criticalCount > 0) {
                console.log(
                  chalk.red(`  ${criticalCount} critical finding(s) — failing the build.`)
                );
              }
              // Fail-closed CI gate: `failed`/`error` OR any critical finding
              // exits non-zero (audit C1: the README pipeline uses `scan --wait`).
              process.exitCode = exitCode;
              break;
            }
            attempts++;
          }
          if (attempts >= 60) {
            pollSpinner.warn("Timed out waiting for results.");
            // A --wait that never resolved must NOT report success in CI.
            process.exitCode = 1;
          }
        }
      } catch (err) {
        // Clean spinner stop + exitCode 1; never process.exit() mid-spinner
        // (libuv UV_HANDLE_CLOSING abort / exit 127 on Windows Node).
        failSpinner(
          spinner,
          `Scan failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
    }
  );

// ─── whoami ───
// Resolves auth via the shared env-first chain and exits non-zero when no
// credential resolves (audit M1). Registered from commands/whoami.ts.
registerWhoami(program);

// ─── Phase 6: New Commands ───
registerEvalLocal(program);
registerScanLocal(program);
registerGenerate(program);
registerValidate(program);
registerVerify(program);
registerCompare(program);
registerList(program);
registerFirewall(program);
registerMcpDiscover(program);
registerWatch(program);
registerGate(program);
registerHistory(program);
registerComplianceCheck(program);
registerCertGap(program);
registerImportPromptfoo(program);
registerImportTraces(program);
registerImportHumanloop(program);
registerImportLangsmith(program);
registerImportBraintrust(program);
registerImportDeepeval(program);
registerImportRagas(program);
registerImportOpenaiEvals(program);
registerImportGiskard(program);
registerPrompt(program);
registerEnv(program);
registerTool(program);
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
registerSkillScan(program);
registerView(program);
registerCache(program);
registerGenerateDataset(program);
registerOptimize(program);
registerBenchmark(program);
registerDetectorEval(program);
registerAttackProof(program);
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
registerGuardrail(program);
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
function reportFatal(err: unknown): void {
  // Set process.exitCode + return rather than process.exit(): a thrown/rejected
  // action (e.g. a 4xx from a `... list` command's global-fetch call) lands here
  // while undici's keep-alive sockets from that just-failed request are still in
  // teardown. Calling process.exit() mid-teardown trips a libuv
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` abort (exit
  // 0xC0000409 / 127) on Windows Node instead of exiting with the intended code.
  // Letting the handler return drains the open handles and exits cleanly with
  // process.exitCode — the same guard as fix #1183 / lib/poll.ts failExit.
  const code = (err as { exitCode?: unknown })?.exitCode;
  if (typeof code === "number") {
    // Commander already wrote its own message; honor its exit code.
    process.exitCode = code;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = 1;
}

// A handler that throws after the event loop has drained (e.g. a rejected
// fetch in an async action) surfaces here rather than as a raw stack dump.
process.on("unhandledRejection", reportFatal);

// Reject an unknown command BEFORE Commander can treat a trailing `--help` as
// "print the root help and exit 0" (audit: cli-unknown-command-with-help-exits-0).
// Runs on raw argv so it is independent of Commander's option-parsing order.
{
  const known = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
  const bad = checkTopLevelCommand(process.argv.slice(2), known);
  if (bad) {
    console.error(chalk.red(`error: unknown command '${bad.unknown}'`));
    if (bad.suggestion) {
      console.error(chalk.dim(`(Did you mean \`evalguard ${bad.suggestion}\`?)`));
    }
    console.error(chalk.dim("Run `evalguard --help` for the list of commands."));
    process.exit(1);
  }
}

// The same guard, one level down and deeper (audit 2026-08-09:
// cli-unknown-subcommand-with-help-exits-0). `checkTopLevelCommand` above only
// inspects the FIRST positional, so `evalguard benchmark <unrecognised> --help`
// still printed the `benchmark` help and exited 0 — a CI gate keyed on the exit
// code read an unknown benchmark name as success.
{
  const toNode = (c: Command): CommandNode => ({
    name: c.name(),
    aliases: c.aliases(),
    subcommands: c.commands.map((sub) => toNode(sub as Command)),
    // An option consumes the next token when it declares a value placeholder.
    valueOptions: c.options
      .filter((o) => o.required || o.optional)
      .flatMap((o) => [o.short, o.long].filter((f): f is string => Boolean(f))),
    takesPositionalArgs: c.registeredArguments.length > 0,
  });
  const root: CommandNode = {
    ...toNode(program),
    // The root's value-taking options are asserted against this list by
    // __tests__/command-guard.test.ts, so keep both in agreement.
    valueOptions: ROOT_VALUE_OPTIONS,
  };
  const bad = checkCommandPath(process.argv.slice(2), root);
  if (bad) {
    const where = bad.path.join(" ");
    console.error(chalk.red(`error: unknown command '${bad.unknown}'`));
    if (bad.suggestion) {
      console.error(chalk.dim(`(Did you mean \`evalguard ${where} ${bad.suggestion}\`?)`));
    }
    console.error(chalk.dim(`Run \`evalguard ${where} --help\` for the list of subcommands.`));
    process.exit(1);
  }
}

program.parseAsync().catch(reportFatal);
