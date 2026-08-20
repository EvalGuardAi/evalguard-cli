// Detection taxonomy inspired by NVIDIA SkillSpector (Apache-2.0). Clean-room TypeScript implementation; no source copied.
/**
 * `evalguard skill scan <dir>` — SkillSpector-style local skill-package audit.
 *
 * Reads a skill directory from disk (SKILL.md + bundled scripts) under HARD
 * filesystem caps, runs the real @evalguard/core `scanSkillPackage` over the
 * actual script bodies with the Phase-4 code-analysis engines enabled (taint
 * TT1–TT5 + AST-sinks AST1–AST9 + YARA-lite YR1–YR4), and prints a
 * SAFE / CAUTION / DO_NOT_INSTALL verdict.
 *
 * This is the anti-name-sake real-code path: the taint engine closes the
 * multi-statement gap the shipped single-line regexes miss — e.g.
 *   x = model_response()
 *   os.system(x)
 * flags DO_NOT_INSTALL where the legacy regex passes.
 *
 * The reader is HOSTILE-DIR-SAFE: bounded file count, per-file byte cap,
 * recursion-depth cap, and symlinks are refused — a malicious skill directory
 * cannot exhaust the reader before the (already-bounded) engines run.
 *
 * Unlike the production publish route (gated behind EVALGUARD_SKILL_AST_SCAN /
 * EVALGUARD_SKILL_YARA_SCAN, Phase 5), this explicit local tool runs the deep
 * engines by DEFAULT — use --no-taint / --no-ast / --no-yara to disable.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

/* ─── hard filesystem caps (hostile-dir safety) ────────────────────────────── */

export const DEFAULT_MAX_FILES = 500;
export const DEFAULT_MAX_BYTES_PER_FILE = 1_000_000; // 1 MB
export const DEFAULT_MAX_DEPTH = 8;

/** Extensions the code-analysis engines can reason about (+ manifest files). */
const SCRIPT_EXTENSIONS = new Set([
  ".py", ".pyw", ".sh", ".bash", ".zsh",
  ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx",
]);
const MANIFEST_FILES = new Set(["package.json", "requirements.txt"]);
const SKILL_MD_RE = /^skill\.md$/i;
// Directories never worth walking for a skill audit (perf + noise).
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".mypy_cache"]);

/* ─── local mirrors of the @evalguard/core surface (types erased at runtime) ── */

type Severity = "critical" | "high" | "medium" | "low";
type Trust = "verified" | "community" | "flagged";

interface CoreSkillManifest {
  name?: string;
  description?: string;
  [k: string]: unknown;
}
interface CoreSkillScript {
  path: string;
  content: string;
}
interface CoreSkillFinding {
  category: string;
  severity: Severity;
  location: string;
  detail: string;
}
interface CoreSkillScanResult {
  trust: Trust;
  findings: CoreSkillFinding[];
  summary: Record<string, number>;
}
interface CoreSurface {
  parseSkillMd: (md: string) => { manifest: CoreSkillManifest; instructions: string };
  scanSkillPackage: (
    pkg: { manifest: CoreSkillManifest; instructions: string; scripts: CoreSkillScript[] },
    options?: { codeAnalysis?: { taint?: boolean; astSinks?: boolean; yara?: boolean } },
  ) => CoreSkillScanResult;
}

/* ─── filesystem reader (bounded, symlink-refusing) ────────────────────────── */

export interface FsCaps {
  maxFiles: number;
  maxBytesPerFile: number;
  maxDepth: number;
}

export interface SkipRecord {
  path: string;
  reason: string;
}

interface ReadAccumulator {
  scripts: CoreSkillScript[];
  skillMd?: { path: string; content: string; depth: number };
  filesRead: number;
  skipped: SkipRecord[];
  truncated: boolean;
}

function walkSkillDir(dir: string, root: string, depth: number, caps: FsCaps, acc: ReadAccumulator): void {
  if (acc.truncated) return;
  if (depth > caps.maxDepth) {
    acc.skipped.push({ path: path.relative(root, dir) || ".", reason: `exceeds max depth ${caps.maxDepth}` });
    return;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // unreadable dir — skip, never throw
  }
  entries.sort(); // deterministic ordering

  for (const name of entries) {
    if (acc.filesRead >= caps.maxFiles) {
      acc.truncated = true;
      return;
    }
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full); // lstat: do NOT follow symlinks
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      acc.skipped.push({ path: path.relative(root, full), reason: "symlink refused" });
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walkSkillDir(full, root, depth + 1, caps, acc);
      if (acc.truncated) return;
      continue;
    }
    if (!st.isFile()) continue;

    const rel = path.relative(root, full) || name;
    const base = name.toLowerCase();
    const isSkillMd = SKILL_MD_RE.test(name);
    const isScript = SCRIPT_EXTENSIONS.has(path.extname(name).toLowerCase()) || MANIFEST_FILES.has(base);
    if (!isSkillMd && !isScript) continue;

    if (st.size > caps.maxBytesPerFile) {
      acc.skipped.push({ path: rel, reason: `${st.size}B exceeds per-file cap ${caps.maxBytesPerFile}B` });
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    acc.filesRead++;

    if (isSkillMd) {
      // Shallowest SKILL.md wins (the package root manifest).
      if (!acc.skillMd || depth < acc.skillMd.depth) {
        acc.skillMd = { path: rel, content, depth };
      }
    } else {
      acc.scripts.push({ path: rel, content });
    }
  }
}

/* ─── verdict ──────────────────────────────────────────────────────────────── */

export type SkillVerdict = "SAFE" | "CAUTION" | "DO_NOT_INSTALL";

/** Map findings to a SkillSpector-style band. Any critical → DO_NOT_INSTALL;
 *  any high/medium → CAUTION; otherwise SAFE. */
export function computeVerdict(findings: readonly CoreSkillFinding[]): SkillVerdict {
  if (findings.some((f) => f.severity === "critical")) return "DO_NOT_INSTALL";
  if (findings.some((f) => f.severity === "high" || f.severity === "medium")) return "CAUTION";
  return "SAFE";
}

/* ─── pure execution (testable without process.exit) ───────────────────────── */

export interface SkillScanRunOptions {
  dir: string;
  taint: boolean;
  astSinks: boolean;
  yara: boolean;
  /** Fail (exit 1) on CAUTION as well as DO_NOT_INSTALL. */
  strict?: boolean;
  caps?: Partial<FsCaps>;
  /** Injected for tests; defaults to a lazy import of @evalguard/core. */
  loadCore?: () => Promise<CoreSurface>;
}

export interface SkillScanRunResult {
  dir: string;
  skillMdPath?: string;
  filesRead: number;
  scriptCount: number;
  truncated: boolean;
  skipped: SkipRecord[];
  trust: Trust;
  verdict: SkillVerdict;
  findings: CoreSkillFinding[];
  summary: Record<string, number>;
  exitCode: 0 | 1;
}

async function defaultLoadCore(): Promise<CoreSurface> {
  return (await import("@evalguard/core")) as unknown as CoreSurface;
}

/**
 * Read a skill directory under hard caps and scan it. Pure w.r.t. process
 * lifecycle — returns a result instead of exiting, so tests can drive it.
 */
export async function executeSkillScan(opts: SkillScanRunOptions): Promise<SkillScanRunResult> {
  const caps: FsCaps = {
    maxFiles: opts.caps?.maxFiles ?? DEFAULT_MAX_FILES,
    maxBytesPerFile: opts.caps?.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
    maxDepth: opts.caps?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const root = path.resolve(opts.dir);
  const acc: ReadAccumulator = { scripts: [], filesRead: 0, skipped: [], truncated: false };
  walkSkillDir(root, root, 0, caps, acc);

  const core = await (opts.loadCore ?? defaultLoadCore)();
  const parsed = acc.skillMd
    ? core.parseSkillMd(acc.skillMd.content)
    : { manifest: {} as CoreSkillManifest, instructions: "" };

  const result = core.scanSkillPackage(
    { manifest: parsed.manifest, instructions: parsed.instructions, scripts: acc.scripts },
    { codeAnalysis: { taint: opts.taint, astSinks: opts.astSinks, yara: opts.yara } },
  );

  const verdict = computeVerdict(result.findings);
  const exitCode: 0 | 1 =
    verdict === "DO_NOT_INSTALL" || (opts.strict === true && verdict === "CAUTION") ? 1 : 0;

  return {
    dir: root,
    skillMdPath: acc.skillMd?.path,
    filesRead: acc.filesRead,
    scriptCount: acc.scripts.length,
    truncated: acc.truncated,
    skipped: acc.skipped,
    trust: result.trust,
    verdict,
    findings: result.findings,
    summary: result.summary,
    exitCode,
  };
}

/* ─── presentation ─────────────────────────────────────────────────────────── */

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  critical: chalk.red.bold,
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.dim,
};

function verdictBanner(v: SkillVerdict): string {
  switch (v) {
    case "SAFE":
      return chalk.green.bold("  ✓ SAFE");
    case "CAUTION":
      return chalk.yellow.bold("  ! CAUTION");
    case "DO_NOT_INSTALL":
      return chalk.red.bold("  ✗ DO_NOT_INSTALL");
  }
}

function printResult(res: SkillScanRunResult): void {
  console.log();
  console.log(chalk.bold("  EvalGuard Skill Package Scan"));
  console.log(chalk.dim("  " + "-".repeat(70)));
  console.log(`  Directory: ${chalk.cyan(res.dir)}`);
  console.log(`  Manifest:  ${res.skillMdPath ? chalk.cyan(res.skillMdPath) : chalk.dim("(no SKILL.md found)")}`);
  console.log(`  Scanned:   ${chalk.bold(String(res.filesRead))} file(s), ${chalk.bold(String(res.scriptCount))} script(s)`);
  if (res.truncated) console.log(chalk.yellow(`  ⚠ reader hit a resource cap — results are partial`));
  if (res.skipped.length > 0) console.log(chalk.dim(`  Skipped ${res.skipped.length} path(s) (symlink / too large / too deep)`));
  console.log();

  if (res.findings.length > 0) {
    const sorted = [...res.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    for (const f of sorted) {
      const color = SEVERITY_COLOR[f.severity];
      console.log(`    ${color(f.severity.toUpperCase().padEnd(8))} ${chalk.bold(f.category)}  ${chalk.dim(f.location)}`);
      console.log(chalk.dim(`             ${f.detail}`));
    }
    console.log();
  }

  console.log(verdictBanner(res.verdict) + chalk.dim(`   (trust: ${res.trust}, ${res.findings.length} finding(s))`));
  console.log();
}

/* ─── command registration ─────────────────────────────────────────────────── */

export function registerSkillScan(program: Command): void {
  const skill = program.command("skill").description("Agent-skill package security tooling");
  skill
    .command("scan")
    .description("Scan a skill package directory (SKILL.md + scripts) → SAFE / CAUTION / DO_NOT_INSTALL")
    .argument("<dir>", "Path to the skill package directory")
    .option("--no-taint", "Disable the TT1–TT5 source→sink taint engine")
    .option("--no-ast", "Disable the AST1–AST9 dangerous-sink engine")
    .option("--no-yara", "Disable the YARA-lite (YR1–YR4) signature engine")
    .option("--strict", "Exit non-zero on CAUTION as well as DO_NOT_INSTALL", false)
    .option("--json", "Emit JSON (for CI consumption)", false)
    .option("--max-files <n>", "Max files to read", String(DEFAULT_MAX_FILES))
    .option("--max-bytes <n>", "Max bytes per file", String(DEFAULT_MAX_BYTES_PER_FILE))
    .option("--max-depth <n>", "Max recursion depth", String(DEFAULT_MAX_DEPTH))
    .action(
      async (
        dir: string,
        opts: {
          taint?: boolean;
          ast?: boolean;
          yara?: boolean;
          strict?: boolean;
          json?: boolean;
          maxFiles?: string;
          maxBytes?: string;
          maxDepth?: string;
        },
      ) => {
        const target = path.resolve(dir);
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          console.error(chalk.red(`  ✗ Not a directory: ${target}`));
          process.exit(2);
        }

        const parseCap = (raw: string | undefined, fallback: number): number => {
          const n = Number.parseInt(raw ?? "", 10);
          return Number.isFinite(n) && n > 0 ? n : fallback;
        };

        const res = await executeSkillScan({
          dir: target,
          // commander sets opts.taint=false only when --no-taint is passed.
          taint: opts.taint !== false,
          astSinks: opts.ast !== false,
          yara: opts.yara !== false,
          strict: opts.strict === true,
          caps: {
            maxFiles: parseCap(opts.maxFiles, DEFAULT_MAX_FILES),
            maxBytesPerFile: parseCap(opts.maxBytes, DEFAULT_MAX_BYTES_PER_FILE),
            maxDepth: parseCap(opts.maxDepth, DEFAULT_MAX_DEPTH),
          },
        });

        if (opts.json === true) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          printResult(res);
        }
        process.exit(res.exitCode);
      },
    );
}
