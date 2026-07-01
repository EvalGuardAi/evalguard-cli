/**
 * `evalguard ai-bom export <projectId>` — Wave-B3.
 *
 * Exports an AI Bill of Materials for a project. Closes the v10 disclosure
 * that flagged the missing CLI surface ("Phase-K shipped /api/v1/ai-sbom +
 * dashboard page, CLI command is the follow-up").
 *
 *   evalguard ai-bom export <projectId> [--format=cyclonedx|spdx|json]
 *                                       [--out=<path>]
 *
 * Hits GET /api/v1/ai-sbom?projectId=<id>&format=<f> with the user's API
 * key from EVALGUARD_API_KEY. Writes the raw response body to disk
 * (CycloneDX 1.6 / SPDX 2.3 / EvalGuard-native JSON depending on format).
 *
 * No client-side schema validation — the server is canonical; the CLI just
 * streams whatever it gets back. If the server returns 4xx/5xx, we print
 * the error body and exit non-zero so the file isn't half-written.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { enrichWithReputation, highReputationRisk } from "@evalguard/core";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}

function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(
      chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard init` first or export the key."),
    );
    process.exit(1);
  }
  return k;
}

/**
 * Pure function — extracted from the action handler so it's directly
 * unit-testable without spinning a mock CLI. Returns the bytes the
 * server emitted; throws on network / 4xx / 5xx.
 */
export async function fetchAiBom(opts: {
  projectId: string;
  format: "cyclonedx" | "spdx" | "json";
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ body: string; contentType: string; suggestedFilename: string }> {
  if (!UUID_RE.test(opts.projectId)) {
    throw new Error(`projectId must be a valid v4 UUID. Got: ${opts.projectId}`);
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl}/ai-sbom?projectId=${encodeURIComponent(opts.projectId)}&format=${opts.format}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      accept: opts.format === "cyclonedx" || opts.format === "spdx" ? "application/json" : "application/json",
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      detail = ` (${j.error?.code ?? "ERROR"}: ${j.error?.message ?? "unknown"})`;
    } catch {
      try {
        detail = ` — ${await res.text()}`.slice(0, 400);
      } catch {
        // best-effort body capture
      }
    }
    throw new Error(`AI-BOM export failed: HTTP ${res.status}${detail}`);
  }
  const body = await res.text();
  // Suggest a filename based on the Content-Disposition header if present.
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const fallback = `evalguard-ai-bom-${opts.projectId.slice(0, 8)}.${opts.format === "spdx" ? "spdx.json" : opts.format === "cyclonedx" ? "cdx.json" : "json"}`;
  return {
    body,
    contentType: res.headers.get("content-type") ?? "application/json",
    suggestedFilename: m?.[1] ?? fallback,
  };
}

/* ── Supply-chain scan (`ai-bom scan`) ── */

export interface ScanInputs {
  packageJson?: Record<string, unknown>;
  packageLockJson?: Record<string, unknown>;
  pythonRequirements?: string;
  poetryLock?: string;
  goSum?: string;
  goMod?: string;
  pomXml?: string;
  buildGradle?: string;
  gradleLockfile?: string;
}

/**
 * Read whichever manifests / lockfiles exist in `dir`. Pure-ish (fs injectable
 * for tests). Malformed JSON files are skipped with a warning entry rather
 * than aborting the scan — partial coverage beats no coverage.
 */
export function collectScanInputs(
  dir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "readFileSync"> = fs,
): { inputs: ScanInputs; found: string[]; warnings: string[] } {
  const inputs: ScanInputs = {};
  const found: string[] = [];
  const warnings: string[] = [];

  const readJson = (file: string): Record<string, unknown> | undefined => {
    const p = path.join(dir, file);
    if (!fsImpl.existsSync(p)) return undefined;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(p, "utf-8")) as Record<string, unknown>;
      found.push(file);
      return parsed;
    } catch {
      warnings.push(`${file}: invalid JSON — skipped`);
      return undefined;
    }
  };
  const readText = (file: string): string | undefined => {
    const p = path.join(dir, file);
    if (!fsImpl.existsSync(p)) return undefined;
    found.push(file);
    return fsImpl.readFileSync(p, "utf-8");
  };

  inputs.packageJson = readJson("package.json");
  inputs.packageLockJson = readJson("package-lock.json");
  inputs.pythonRequirements = readText("requirements.txt");
  inputs.poetryLock = readText("poetry.lock");
  // Go + Java/Kotlin (Maven/Gradle) — OSV indexes "Go" and "Maven" ecosystems.
  inputs.goSum = readText("go.sum");
  inputs.goMod = readText("go.mod");
  inputs.pomXml = readText("pom.xml");
  inputs.buildGradle = readText("build.gradle") ?? readText("build.gradle.kts");
  inputs.gradleLockfile = readText("gradle.lockfile");
  return { inputs, found, warnings };
}

export interface SbomScanFinding {
  cveId: string;
  affectedPackage: string;
  severity: string;
  cvssScore: number;
  fixedVersion?: string;
  description: string;
}

export interface SbomScanResult {
  vulnerabilities: SbomScanFinding[];
  typosquats: { packageName: string; similarTo: string; severity: string; reason: string }[];
  scan: { mode: string; liveStatus: string; packagesQueried: number; truncatedAdvisoryCount: number; error?: string };
  dependencyResolution: { resolved: number; truncated: number };
}

/** POST the collected inputs to /ai-sbom/generate and pull out the scan results. */
export async function runSbomScan(opts: {
  projectName: string;
  inputs: ScanInputs;
  live: boolean;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<SbomScanResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/ai-sbom/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectName: opts.projectName,
      format: "json",
      liveCveScan: opts.live,
      ...opts.inputs,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      detail = ` (${j.error?.code ?? "ERROR"}: ${j.error?.message ?? "unknown"})`;
    } catch {
      // best-effort body capture
    }
    throw new Error(`Supply-chain scan failed: HTTP ${res.status}${detail}`);
  }
  const body = (await res.json()) as {
    data?: {
      bom?: { vulnerabilities?: SbomScanFinding[] };
      supplyChain?: Omit<SbomScanResult, "vulnerabilities">;
    };
  };
  const supplyChain = body.data?.supplyChain;
  if (!supplyChain) throw new Error("Malformed scan response: missing supplyChain block");
  return {
    vulnerabilities: body.data?.bom?.vulnerabilities ?? [],
    typosquats: supplyChain.typosquats ?? [],
    scan: supplyChain.scan,
    dependencyResolution: supplyChain.dependencyResolution,
  };
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/**
 * CI gate: true (fail) when any vulnerability OR typosquat reaches the
 * `failOn` severity threshold.
 */
export function severityGateFails(result: SbomScanResult, failOn: string): boolean {
  const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.critical;
  const worstVuln = Math.max(0, ...result.vulnerabilities.map((v) => SEVERITY_RANK[v.severity] ?? 0));
  const worstSquat = Math.max(0, ...result.typosquats.map((t) => SEVERITY_RANK[t.severity] ?? 0));
  return Math.max(worstVuln, worstSquat) >= threshold;
}

export function registerAiBom(program: Command): void {
  const cmd = program
    .command("ai-bom")
    .description("Export AI Bill of Materials (SBOM) for a project");

  cmd
    .command("export")
    .description("Export a project's AI-BOM as CycloneDX / SPDX / native JSON")
    .argument("<projectId>", "Project UUID (visible on the project settings page)")
    .option("-f, --format <fmt>", "Export format: cyclonedx | spdx | json", "cyclonedx")
    .option("-o, --out <path>", "Output file path (default: ./evalguard-ai-bom-<id>.<ext>)")
    .action(
      async (
        projectId: string,
        opts: { format: string; out?: string },
      ) => {
        const fmt = opts.format.toLowerCase();
        if (fmt !== "cyclonedx" && fmt !== "spdx" && fmt !== "json") {
          console.error(chalk.red(`Unknown format: ${opts.format}. Choose: cyclonedx | spdx | json`));
          process.exit(1);
        }
        console.log();
        console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — AI Bill of Materials export"));
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
        console.log();
        console.log(`  Project: ${chalk.cyan(projectId)}`);
        console.log(`  Format:  ${chalk.cyan(fmt)}`);
        console.log();

        let result;
        try {
          result = await fetchAiBom({
            projectId,
            format: fmt as "cyclonedx" | "spdx" | "json",
            baseUrl: baseUrl(),
            apiKey: apiKey(),
          });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        const outputPath = path.resolve(opts.out ?? result.suggestedFilename);
        fs.writeFileSync(outputPath, result.body, "utf-8");

        console.log(`  ${chalk.green("✓")} Wrote ${result.body.length} bytes to ${chalk.cyan(outputPath)}`);
        console.log();
        console.log(chalk.bold("  Next steps:"));
        if (fmt === "cyclonedx") {
          console.log(`    • Validate: ${chalk.cyan("cyclonedx validate --input-file " + path.basename(outputPath))}`);
          console.log(`    • Spec: https://cyclonedx.org/specification/overview/`);
        } else if (fmt === "spdx") {
          console.log(`    • Validate: ${chalk.cyan("pyspdxtools --infile " + path.basename(outputPath))}`);
          console.log(`    • Spec: https://spdx.dev/specifications/`);
        }
        console.log(`    • EU AI Act Annex IV uses this kind of inventory for risk-class disclosure.`);
        console.log();
      },
    );

  cmd
    .command("scan")
    .description("Scan local manifests/lockfiles for CVEs (live OSV.dev) + typosquats — CI-gateable")
    .option("-d, --dir <path>", "Project directory to scan", ".")
    .option("-n, --project-name <name>", "Project name for the report", "local-scan")
    .option("--fail-on <severity>", "Exit 1 when a finding reaches: critical | high | medium | low", "critical")
    .option("--no-live", "Skip live OSV.dev lookups (offline static DB + typosquats only)")
    .option("--json", "Print the raw scan result as JSON")
    .action(
      async (opts: { dir: string; projectName: string; failOn: string; live: boolean; json?: boolean }) => {
        const failOn = opts.failOn.toLowerCase();
        if (!["critical", "high", "medium", "low"].includes(failOn)) {
          console.error(chalk.red(`Unknown --fail-on: ${opts.failOn}. Choose: critical | high | medium | low`));
          process.exit(1);
        }
        const dir = path.resolve(opts.dir);
        const { inputs, found, warnings } = collectScanInputs(dir);
        if (found.length === 0) {
          console.error(
            chalk.red(
              `No supported manifest/lockfile found in ${dir} ` +
              `(package.json, package-lock.json, requirements.txt, poetry.lock, ` +
              `go.sum, go.mod, pom.xml, build.gradle(.kts), gradle.lockfile)`,
            ),
          );
          process.exit(1);
        }

        if (!opts.json) {
          console.log();
          console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — supply-chain scan"));
          console.log(chalk.dim("  ─────────────────────────────────────────────"));
          console.log();
          console.log(`  Inputs:  ${chalk.cyan(found.join(", "))}`);
          for (const w of warnings) console.log(`  ${chalk.yellow("!")} ${w}`);
          console.log(`  Mode:    ${chalk.cyan(opts.live ? "live (OSV.dev + static DB)" : "offline (static DB only)")}`);
          console.log();
        }

        let result: SbomScanResult;
        try {
          result = await runSbomScan({
            projectName: opts.projectName,
            inputs,
            live: opts.live,
            baseUrl: baseUrl(),
            apiKey: apiKey(),
          });
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const counts: Record<string, number> = {};
          for (const v of result.vulnerabilities) counts[v.severity] = (counts[v.severity] ?? 0) + 1;
          console.log(
            `  Dependencies resolved: ${chalk.cyan(String(result.dependencyResolution.resolved))}` +
            (result.dependencyResolution.truncated > 0
              ? chalk.yellow(` (+${result.dependencyResolution.truncated} beyond cap, not scanned)`)
              : ""),
          );
          if (result.scan.liveStatus === "degraded") {
            console.log(`  ${chalk.yellow("!")} Live OSV scan degraded (${result.scan.error ?? "unknown"}) — static results only`);
          }
          if (result.scan.truncatedAdvisoryCount > 0) {
            console.log(`  ${chalk.yellow("!")} ${result.scan.truncatedAdvisoryCount} advisories matched but not detailed (cap)`);
          }
          console.log();
          if (result.vulnerabilities.length === 0) {
            console.log(`  ${chalk.green("✓")} No known vulnerabilities in scanned dependencies`);
          } else {
            console.log(chalk.bold(`  Vulnerabilities (${result.vulnerabilities.length}):`));
            const order = ["critical", "high", "medium", "low", "none"];
            for (const sev of order) {
              if (counts[sev]) {
                const color = sev === "critical" || sev === "high" ? chalk.red : sev === "medium" ? chalk.yellow : chalk.dim;
                console.log(`    ${color(`${sev}: ${counts[sev]}`)}`);
              }
            }
            for (const v of result.vulnerabilities.slice(0, 15)) {
              const fix = v.fixedVersion ? chalk.green(` → fix: ${v.fixedVersion}`) : "";
              console.log(`    ${chalk.red(v.cveId)} ${v.affectedPackage} [${v.severity}]${fix}`);
            }
            if (result.vulnerabilities.length > 15) {
              console.log(chalk.dim(`    … and ${result.vulnerabilities.length - 15} more (use --json for all)`));
            }
          }
          console.log();
          if (result.typosquats.length > 0) {
            console.log(chalk.bold(`  Possible typosquats (${result.typosquats.length}):`));
            for (const t of result.typosquats) {
              console.log(`    ${chalk.red(t.packageName)} resembles ${chalk.cyan(t.similarTo)} — ${t.reason}`);
            }
            console.log();
          }
        }

        if (severityGateFails(result, failOn)) {
          if (!opts.json) console.error(chalk.red(`  ✗ Gate failed: findings at or above "${failOn}"`));
          process.exit(1);
        }
        if (!opts.json) console.log(`  ${chalk.green("✓")} Gate passed (--fail-on ${failOn})`);
      },
    );

  cmd
    .command("reputation [packages...]")
    .description("Score dependency reputation (npm age/maintainers/downloads/deprecation) — the malicious/abandoned-package risk OSV can't see")
    .option("-d, --dir <path>", "Read deps from package.json in this dir (when no packages given)", ".")
    .option("--threshold <n>", "Risk threshold to flag (0..1)", "0.5")
    .option("--fail-on-risk", "Exit 1 if any package is at/above the threshold")
    .option("--json", "Emit JSON")
    .action(async (pkgArgs: string[], opts: { dir: string; threshold: string; failOnRisk?: boolean; json?: boolean }) => {
      let names = pkgArgs ?? [];
      if (names.length === 0) {
        const pj = path.join(path.resolve(opts.dir), "package.json");
        if (!fs.existsSync(pj)) {
          console.error(chalk.red(`No packages given and no package.json in ${opts.dir}`));
          process.exit(1);
        }
        const json = JSON.parse(fs.readFileSync(pj, "utf8")) as Record<string, Record<string, string>>;
        names = [
          ...Object.keys(json.dependencies ?? {}),
          ...Object.keys(json.devDependencies ?? {}),
          ...Object.keys(json.optionalDependencies ?? {}),
        ];
      }
      if (names.length === 0) { console.error(chalk.red("No dependencies found.")); process.exit(1); }

      const threshold = Math.max(0, Math.min(1, Number(opts.threshold) || 0.5));
      console.log(chalk.dim(`Scoring reputation for ${names.length} package(s)…`));
      const reps = await enrichWithReputation(names);

      if (opts.json) { console.log(JSON.stringify(reps, null, 2)); }
      else {
        const risky = highReputationRisk(reps, threshold);
        if (risky.length === 0) {
          console.log(`  ${chalk.green("✓")} No packages at/above risk ${threshold}`);
        } else {
          console.log(chalk.bold(`\n  ${risky.length} risky package(s):`));
          for (const r of risky) {
            console.log(`    ${chalk.red(r.name.padEnd(28))} risk=${r.reputationRisk}  ${chalk.dim(r.flags.join(", "))}`);
          }
        }
        const unknown = reps.filter((r) => r.reputationRisk === null);
        if (unknown.length > 0) console.log(chalk.dim(`\n  (${unknown.length} package(s) had no registry metadata)`));
      }

      if (opts.failOnRisk && highReputationRisk(reps, threshold).length > 0) {
        if (!opts.json) console.error(chalk.red(`  ✗ Gate failed: package(s) at/above reputation risk ${threshold}`));
        process.exit(1);
      }
    });
}
