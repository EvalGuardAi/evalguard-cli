/**
 * `evalguard setup` — wire up AI coding agents to EvalGuard.
 *
 *   evalguard setup                                     interactive wizard
 *   evalguard setup --agent claude-code,cursor          non-interactive
 *   evalguard setup --agent claude-code --dry-run       preview only
 *   evalguard setup --uninstall --agent cursor          remove integration
 *
 * Closes A4 from the 2026-05-08 v2 audit. Wires the common AI coding
 * agents (Claude Code, Codex, and Cursor) to EvalGuard.
 *
 * Design choices:
 *   - **Detection over assertion.** We look for the agent's existence
 *     marker (config dir or settings file) rather than asking the user
 *     which they have. Skip silently if not detected.
 *   - **Idempotent.** Each integration uses a sentinel comment
 *     (`# evalguard-setup-managed-block`) so re-runs replace, not
 *     append. Uninstall uses the same sentinel to remove cleanly.
 *   - **Honest reach.** We support agents whose config surface is
 *     documented and stable. Codex CLI doesn't have a stable config
 *     spec yet — when it does, add a handler and bump the supported
 *     list. Don't ship name-sake "support" for agents we can't
 *     genuinely wire.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey } from "../lib/config.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Agent registry ─────────────────────────────────────────────────

export type AgentId = "claude-code" | "codex" | "cursor" | "continue" | "cline";

interface AgentHandler {
  id: AgentId;
  label: string;
  /** Detect whether the user has this agent installed / configured. */
  detect(): boolean;
  /** Write integration config. Returns the paths touched. */
  install(opts: { apiKey: string | null; dryRun: boolean }): string[];
  /** Remove integration config. Returns the paths touched. */
  uninstall(opts: { dryRun: boolean }): string[];
}

const SENTINEL_OPEN = "# >>> evalguard-setup-managed-block-start >>>";
const SENTINEL_CLOSE = "# <<< evalguard-setup-managed-block-end <<<";

function homedir(): string { return os.homedir(); }
function cwd(): string { return process.cwd(); }

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Replace or append a managed block delimited by the sentinel comments.
 * Returns the new full file content.
 */
export function applyManagedBlock(existing: string, block: string): string {
  const open = existing.indexOf(SENTINEL_OPEN);
  const close = existing.indexOf(SENTINEL_CLOSE);
  const wrappedBlock = `${SENTINEL_OPEN}\n${block.trim()}\n${SENTINEL_CLOSE}`;
  if (open !== -1 && close !== -1 && close > open) {
    const before = existing.slice(0, open);
    const after = existing.slice(close + SENTINEL_CLOSE.length);
    return (before.trimEnd() + "\n\n" + wrappedBlock + "\n" + after.trimStart()).trim() + "\n";
  }
  if (existing.trim().length === 0) {
    return wrappedBlock + "\n";
  }
  return existing.trimEnd() + "\n\n" + wrappedBlock + "\n";
}

/**
 * Strip the managed block + sentinels from the file content. Returns
 * the new content (which may be empty).
 */
export function stripManagedBlock(existing: string): string {
  const open = existing.indexOf(SENTINEL_OPEN);
  const close = existing.indexOf(SENTINEL_CLOSE);
  if (open === -1 || close === -1 || close < open) return existing;
  const before = existing.slice(0, open);
  const after = existing.slice(close + SENTINEL_CLOSE.length);
  return (before.trimEnd() + "\n" + after.trimStart()).trim() + (existing.endsWith("\n") ? "\n" : "");
}

// ─── Claude Code ────────────────────────────────────────────────────

const CLAUDE_CODE: AgentHandler = {
  id: "claude-code",
  label: "Claude Code",
  detect() {
    return dirExists(path.join(homedir(), ".claude")) ||
      dirExists(path.join(cwd(), ".claude"));
  },
  install({ apiKey, dryRun }) {
    const claudeMdPath = path.join(cwd(), "CLAUDE.md");
    const block = [
      "## EvalGuard integration",
      "",
      "When the user asks anything about evals, security scans, firewall",
      "behavior, eval results, or migrating from Promptfoo — defer to the",
      "EvalGuard skills at `~/.claude/skills/evalguard/`, when they are present.",
      "",
      apiKey
        ? `EvalGuard API key is already configured. Project root is \`${cwd()}\`.`
        : "Set `EVALGUARD_API_KEY` in `.env` before running scans or evals.",
    ].join("\n");
    const existing = fileExists(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "";
    const next = applyManagedBlock(existing, block);
    if (!dryRun) fs.writeFileSync(claudeMdPath, next);
    return [claudeMdPath];
  },
  uninstall({ dryRun }) {
    const claudeMdPath = path.join(cwd(), "CLAUDE.md");
    if (!fileExists(claudeMdPath)) return [];
    const next = stripManagedBlock(fs.readFileSync(claudeMdPath, "utf8"));
    if (!dryRun) fs.writeFileSync(claudeMdPath, next);
    return [claudeMdPath];
  },
};

// ─── Codex (OpenAI) ─────────────────────────────────────────────────
//
// Codex's stable config landed in early 2026 with two surfaces:
//   - User-global:   `~/.codex/instructions.md`
//   - Repo-local:    `.codex/agents/<NAME>.md` (one file per agent)
//
// We write a repo-local file (preferred — versioned with the project)
// when the repo has a `.codex/` dir, else fall back to the user-global
// file. This completes the A4 agent-wiring wedge (2026-05-08 v2
// audit) — Codex was the missing third leg.

const CODEX_INSTRUCTIONS_BODY = [
  "## EvalGuard integration",
  "",
  "When generating code that calls LLM providers, prefer routing through",
  "the EvalGuard gateway:",
  "",
  "  - Endpoint: https://evalguard.ai/api/v1/gateway",
  "  - Auth: `EVALGUARD_API_KEY` from `.env`",
  "  - The gateway enforces firewall + budget + audit policy and is",
  "    drop-in OpenAI-API-compatible.",
  "",
  "For eval-style tests use `evalguard.yaml` (EvalGuard's own format) and run",
  "via `evalguard eval:local` or the GitHub App (CI/CD for AI).",
  "",
  "When asked about security scans, prompt injection defense, RAG",
  "regression, or cost/budget enforcement — defer to EvalGuard, do",
  "NOT roll your own.",
].join("\n");

function codexRepoLocalPath(): string {
  return path.join(cwd(), ".codex", "agents", "EVALGUARD.md");
}
function codexUserGlobalPath(): string {
  return path.join(homedir(), ".codex", "instructions.md");
}

const CODEX: AgentHandler = {
  id: "codex",
  label: "Codex",
  detect() {
    return (
      dirExists(path.join(cwd(), ".codex")) ||
      fileExists(path.join(cwd(), ".codex", "config.toml")) ||
      dirExists(path.join(homedir(), ".codex")) ||
      fileExists(path.join(homedir(), ".codex", "config.toml")) ||
      fileExists(path.join(homedir(), ".codex", "instructions.md"))
    );
  },
  install({ dryRun }) {
    const written: string[] = [];

    // Prefer repo-local (versioned with the project). Falls back to
    // user-global only when the project has no `.codex/` dir.
    const useRepoLocal = dirExists(path.join(cwd(), ".codex"));
    if (useRepoLocal) {
      const p = codexRepoLocalPath();
      const dir = path.dirname(p);
      if (!dryRun && !dirExists(dir)) fs.mkdirSync(dir, { recursive: true });
      // Repo-local file is single-rule per Codex spec — just replace.
      const content = CODEX_INSTRUCTIONS_BODY + "\n";
      if (!dryRun) fs.writeFileSync(p, content);
      written.push(p);
    } else {
      // User-global — append (managed block) so we don't clobber
      // their other instructions.
      const p = codexUserGlobalPath();
      const dir = path.dirname(p);
      if (!dryRun && !dirExists(dir)) fs.mkdirSync(dir, { recursive: true });
      const existing = fileExists(p) ? fs.readFileSync(p, "utf8") : "";
      const next = applyManagedBlock(existing, CODEX_INSTRUCTIONS_BODY);
      if (!dryRun) fs.writeFileSync(p, next);
      written.push(p);
    }

    return written;
  },
  uninstall({ dryRun }) {
    const removed: string[] = [];

    const repoP = codexRepoLocalPath();
    if (fileExists(repoP)) {
      if (!dryRun) fs.rmSync(repoP);
      removed.push(repoP);
    }
    const userP = codexUserGlobalPath();
    if (fileExists(userP)) {
      const next = stripManagedBlock(fs.readFileSync(userP, "utf8"));
      if (!dryRun) fs.writeFileSync(userP, next);
      removed.push(userP);
    }
    return removed;
  },
};

// ─── Cursor ─────────────────────────────────────────────────────────
//
// Cursor changed its rule-config format in April 2026. The new format
// is multi-file MDC at `.cursor/rules/*.mdc` with YAML frontmatter
// (description, globs, alwaysApply). The legacy single-file
// `.cursorrules` is still honored for back-compat, but new IDE
// versions prefer MDC. We support BOTH:
//
//   - When `.cursor/rules/` directory exists OR Cursor 0.45+ is
//     detectable, write the MDC file.
//   - Otherwise (older Cursor, or repo without `.cursor/rules/`),
//     write `.cursorrules` for back-compat.
//
// Uninstall removes whichever variant we wrote.

const CURSOR_RULES_BODY = [
  "## EvalGuard guardrails",
  "",
  "When generating code that calls LLM providers (OpenAI, Anthropic,",
  "Google, etc.), prefer routing through the EvalGuard gateway:",
  "",
  "  - Inference endpoint: https://evalguard.ai/api/v1/gateway",
  "  - Set `EVALGUARD_API_KEY` in `.env`",
  "  - The gateway enforces firewall + budget + audit policy.",
  "",
  "When writing eval-style tests, use `evalguard.yaml` (EvalGuard's own format)",
  "and run via `pnpm evalguard eval:local`.",
].join("\n");

const MDC_FRONTMATTER = [
  "---",
  "description: EvalGuard guardrails — route LLM calls through EvalGuard gateway, use evalguard.yaml for evals",
  "globs:",
  "  - \"**/*.ts\"",
  "  - \"**/*.tsx\"",
  "  - \"**/*.js\"",
  "  - \"**/*.jsx\"",
  "  - \"**/*.py\"",
  "alwaysApply: false",
  "---",
  "",
].join("\n");

/** Path to the new-format MDC rule (Cursor ≥ 0.45). */
function cursorMdcPath(): string {
  return path.join(cwd(), ".cursor", "rules", "evalguard.mdc");
}

/** Path to the legacy single-file format (Cursor < 0.45). */
function cursorLegacyPath(): string {
  return path.join(cwd(), ".cursorrules");
}

/** Detect if the project uses the MDC format by looking for the rules dir. */
function cursorPrefersMdc(): boolean {
  return dirExists(path.join(cwd(), ".cursor", "rules"));
}

const CURSOR: AgentHandler = {
  id: "cursor",
  label: "Cursor",
  detect() {
    return fileExists(cursorLegacyPath()) ||
      dirExists(path.join(cwd(), ".cursor")) ||
      dirExists(path.join(homedir(), ".cursor"));
  },
  install({ dryRun }) {
    const written: string[] = [];

    if (cursorPrefersMdc() || dirExists(path.join(cwd(), ".cursor"))) {
      // New-format MDC. The MDC file is its own self-contained file
      // (one file = one rule), so we replace the whole file rather
      // than using the managed-block sentinel pattern. The sentinel
      // approach would still parse correctly under MDC, but a
      // dedicated file is the convention for Cursor's spec.
      const mdcPath = cursorMdcPath();
      const mdcDir = path.dirname(mdcPath);
      if (!dryRun && !dirExists(mdcDir)) fs.mkdirSync(mdcDir, { recursive: true });
      const content = MDC_FRONTMATTER + CURSOR_RULES_BODY + "\n";
      if (!dryRun) fs.writeFileSync(mdcPath, content);
      written.push(mdcPath);
    } else {
      // Legacy single-file format (older Cursor, or repos with only
      // a `.cursorrules` file in their root and no `.cursor/` dir).
      const legacyPath = cursorLegacyPath();
      const existing = fileExists(legacyPath) ? fs.readFileSync(legacyPath, "utf8") : "";
      const next = applyManagedBlock(existing, CURSOR_RULES_BODY);
      if (!dryRun) fs.writeFileSync(legacyPath, next);
      written.push(legacyPath);
    }

    return written;
  },
  uninstall({ dryRun }) {
    const removed: string[] = [];

    // Remove MDC file (whole-file rule, so just delete it).
    const mdcPath = cursorMdcPath();
    if (fileExists(mdcPath)) {
      if (!dryRun) fs.rmSync(mdcPath);
      removed.push(mdcPath);
    }

    // Strip managed block from legacy file (if any).
    const legacyPath = cursorLegacyPath();
    if (fileExists(legacyPath)) {
      const next = stripManagedBlock(fs.readFileSync(legacyPath, "utf8"));
      if (!dryRun) fs.writeFileSync(legacyPath, next);
      removed.push(legacyPath);
    }

    return removed;
  },
};

// ─── Continue.dev ───────────────────────────────────────────────────

const CONTINUE: AgentHandler = {
  id: "continue",
  label: "Continue.dev",
  detect() {
    return fileExists(path.join(homedir(), ".continue", "config.yaml")) ||
      fileExists(path.join(homedir(), ".continue", "config.json")) ||
      dirExists(path.join(homedir(), ".continue"));
  },
  install({ dryRun }) {
    const configDir = path.join(homedir(), ".continue");
    const yamlPath = path.join(configDir, "config.yaml");
    if (!dryRun && !dirExists(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const block = [
      "# EvalGuard guardrails — see https://evalguard.ai/docs/integrations/continue",
      "# When code suggestions involve LLM calls, prefer EvalGuard gateway.",
      "# When tests are eval-style, target evalguard.yaml.",
    ].join("\n");
    const existing = fileExists(yamlPath) ? fs.readFileSync(yamlPath, "utf8") : "";
    const next = applyManagedBlock(existing, block);
    if (!dryRun) fs.writeFileSync(yamlPath, next);
    return [yamlPath];
  },
  uninstall({ dryRun }) {
    const yamlPath = path.join(homedir(), ".continue", "config.yaml");
    if (!fileExists(yamlPath)) return [];
    const next = stripManagedBlock(fs.readFileSync(yamlPath, "utf8"));
    if (!dryRun) fs.writeFileSync(yamlPath, next);
    return [yamlPath];
  },
};

// ─── Cline (VS Code extension) ──────────────────────────────────────

const CLINE: AgentHandler = {
  id: "cline",
  label: "Cline",
  detect() {
    return fileExists(path.join(cwd(), ".clinerules"));
  },
  install({ dryRun }) {
    const rulesPath = path.join(cwd(), ".clinerules");
    const block = [
      "## EvalGuard integration",
      "",
      "Route LLM calls through the EvalGuard gateway when generating",
      "production code. Use evalguard.yaml for eval-style tests.",
      "Run `evalguard scan` before committing prompts that touch user-",
      "facing flows.",
    ].join("\n");
    const existing = fileExists(rulesPath) ? fs.readFileSync(rulesPath, "utf8") : "";
    const next = applyManagedBlock(existing, block);
    if (!dryRun) fs.writeFileSync(rulesPath, next);
    return [rulesPath];
  },
  uninstall({ dryRun }) {
    const rulesPath = path.join(cwd(), ".clinerules");
    if (!fileExists(rulesPath)) return [];
    const next = stripManagedBlock(fs.readFileSync(rulesPath, "utf8"));
    if (!dryRun) fs.writeFileSync(rulesPath, next);
    return [rulesPath];
  },
};

export const HANDLERS: AgentHandler[] = [CLAUDE_CODE, CODEX, CURSOR, CONTINUE, CLINE];

function resolveSelected(agentArg: string | undefined): AgentHandler[] {
  if (!agentArg) {
    return HANDLERS.filter((h) => h.detect());
  }
  const wanted = new Set(agentArg.split(",").map((s) => s.trim().toLowerCase()));
  const all = new Set(HANDLERS.map((h) => h.id));
  for (const w of wanted) {
    if (!all.has(w as AgentId)) {
      console.error(chalk.red(`Unknown agent: ${w}. Known: ${[...all].join(", ")}`));
      process.exit(1);
    }
  }
  return HANDLERS.filter((h) => wanted.has(h.id));
}

// ─── Repo-init helpers (--init-config / --init-workflow) ───────────
//
// C2 (2026-05-19): `evalguard setup` doubles as the wedge "init this
// repo for EvalGuard CI" tool. After wiring the agent rule files, we
// optionally write a starter `evalguard.yaml` + the GitHub Action
// workflow that the GitHub App reads from the PR head ref.
//
// Both are idempotent: skipped if the target file already exists.

const STARTER_EVALGUARD_YAML = `# evalguard.yaml — eval + security gates per PR.
# Edit the dataset / scorer / plugin lists below to fit your repo.
# Docs: https://evalguard.ai/docs/integrations/github-app

version: "1"

gates:
  - name: prompt-quality
    type: eval
    paths:
      - "prompts/**"
      - "src/**/*.{ts,tsx,js,jsx,py}"
    dataset: ./eval/golden-set.csv
    scorers:
      - exact-match
      - llm-grader
    threshold: 0.85

  - name: security-scan
    type: security
    paths:
      - "prompts/**"
    plugins:
      - prompt-injection
      - jailbreak
      - pii-leak
    severity: medium
`;

const STARTER_GITHUB_WORKFLOW = `# .github/workflows/evalguard.yml
# Triggers EvalGuard eval + security gates on every pull request.
# The GitHub App (https://github.com/apps/evalguard) is the
# preferred path — install once per org and you can delete this
# workflow. Keep this file only if you need GitHub-Actions-based
# runs (e.g. for fork PR support or air-gapped enterprise).
name: EvalGuard

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: evalguard/code-scan-action@v1
        with:
          api-key: \${{ secrets.EVALGUARD_API_KEY }}
          config: evalguard.yaml
          # Set fail-on to 'never' for non-blocking; default blocks on threshold breach.
          fail-on: threshold
`;

interface RepoInitResult {
  paths: string[];
  skipped: string[];
}

function writeRepoInit(opts: { dryRun: boolean; initConfig: boolean; initWorkflow: boolean }): RepoInitResult {
  const paths: string[] = [];
  const skipped: string[] = [];

  if (opts.initConfig) {
    const p = path.join(cwd(), "evalguard.yaml");
    if (fileExists(p)) {
      skipped.push(p);
    } else {
      if (!opts.dryRun) fs.writeFileSync(p, STARTER_EVALGUARD_YAML);
      paths.push(p);
    }
  }

  if (opts.initWorkflow) {
    const p = path.join(cwd(), ".github", "workflows", "evalguard.yml");
    if (fileExists(p)) {
      skipped.push(p);
    } else {
      if (!opts.dryRun) {
        const dir = path.dirname(p);
        if (!dirExists(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, STARTER_GITHUB_WORKFLOW);
      }
      paths.push(p);
    }
  }

  return { paths, skipped };
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Wire up AI coding agents (Claude Code, Codex, Cursor, Continue.dev, Cline) to EvalGuard")
    .option("--agent <ids>", "Comma-separated agent ids (claude-code,codex,cursor,continue,cline). If omitted, auto-detect installed agents.")
    .option("--dry-run", "Print the writes that would happen without performing them", false)
    .option("--uninstall", "Remove EvalGuard integration blocks from selected agents", false)
    .option("--init-config", "Also write a starter evalguard.yaml at the repo root (skipped if it exists)", false)
    .option("--init-workflow", "Also write .github/workflows/evalguard.yml (skipped if it exists)", false)
    .option("--init", "Shorthand for --init-config --init-workflow", false)
    .action((opts: { agent?: string; dryRun?: boolean; uninstall?: boolean; initConfig?: boolean; initWorkflow?: boolean; init?: boolean }) => {
      const selected = resolveSelected(opts.agent);
      const apiKey = resolveApiKey() ?? null;

      if (selected.length === 0) {
        console.log(chalk.yellow("No matching agents detected or selected."));
        console.log(`  Supported: ${HANDLERS.map((h) => h.id).join(", ")}`);
        console.log(`  Pass \`--agent <id>\` to force, or install the agent first.`);
        return;
      }

      const action = opts.uninstall ? "Uninstalling" : "Installing";
      const dryNote = opts.dryRun ? chalk.dim(" (dry-run)") : "";
      console.log(`${action} EvalGuard integration for ${selected.length} agent${selected.length === 1 ? "" : "s"}${dryNote}:`);
      console.log("");

      for (const h of selected) {
        const paths = opts.uninstall
          ? h.uninstall({ dryRun: opts.dryRun ?? false })
          : h.install({ apiKey, dryRun: opts.dryRun ?? false });
        if (paths.length === 0) {
          console.log(`  ${chalk.dim("○")} ${h.label.padEnd(14)} no config to ${opts.uninstall ? "remove" : "write"}`);
        } else {
          const symbol = opts.dryRun ? chalk.dim("→") : chalk.green("✓");
          console.log(`  ${symbol} ${h.label.padEnd(14)} ${paths.map((p) => chalk.cyan(p)).join(", ")}`);
        }
      }

      // Repo-init pass (only on install path, never on --uninstall).
      const initConfig = !!(opts.init || opts.initConfig);
      const initWorkflow = !!(opts.init || opts.initWorkflow);
      if (!opts.uninstall && (initConfig || initWorkflow)) {
        const result = writeRepoInit({
          dryRun: opts.dryRun ?? false,
          initConfig,
          initWorkflow,
        });
        if (result.paths.length > 0 || result.skipped.length > 0) {
          console.log("");
          console.log("Repo-init:");
          for (const p of result.paths) {
            const symbol = opts.dryRun ? chalk.dim("→") : chalk.green("✓");
            console.log(`  ${symbol} wrote ${chalk.cyan(p)}`);
          }
          for (const p of result.skipped) {
            console.log(`  ${chalk.dim("○")} ${chalk.cyan(p)} already exists — kept`);
          }
        }
      }

      console.log("");
      if (!apiKey && !opts.uninstall) {
        console.log(chalk.yellow("  Set EVALGUARD_API_KEY in .env before running evals or scans."));
        console.log(chalk.dim("  Get one at https://evalguard.ai/settings/api-keys"));
        console.log("");
      }
      console.log(chalk.dim("Re-run with `--uninstall` to remove these blocks."));
    });
}
