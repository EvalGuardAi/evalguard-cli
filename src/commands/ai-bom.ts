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
 * key from EVALGUARD_API_KEY. Writes the response document to disk.
 *
 * ─── 2026-08-09: the body is VALIDATED before it becomes a file ────────────
 *
 * This header used to read "No client-side schema validation — the server is
 * canonical; the CLI just streams whatever it gets back." Measured against the
 * built CLI, that policy produced these, each written to disk as a CycloneDX
 * SBOM, each with exit 0:
 *
 *     ✓ Wrote 27 bytes …   body was `this is not JSON at all {{{`
 *     ✓ Wrote 0 bytes …    body was empty (and again for a 204)
 *     ✓ Wrote 4 bytes …    body was `null`
 *     ✓ Wrote 157 bytes …  body was an nginx 502 error page
 *     ✓ Wrote 2097152 …    body was 2 MB of filler
 *
 * — followed by `• Validate: cyclonedx validate --input-file <that file>`.
 *
 * "The server is canonical" is a statement about SCHEMA authority. It is not a
 * reason to accept bytes that demonstrably did not come from the server's SBOM
 * generator: 10 of 14 fault modes were indistinguishable from a successful
 * export. `readArtifactBody` (lib/http.ts) now proves the document is the
 * AI-BOM route's answer, in the format that was REQUESTED, before any file is
 * created — and no file is created when it is not.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import * as fs from "fs";
import * as path from "path";
import { enrichWithReputation, highReputationRisk } from "@evalguard/core";
import {
  AI_BOM_FORMATS,
  AI_BOM_MARKERS,
  type AiBomFormat,
  boundedFetch,
  decodeJsonBody,
  isAiBomFormat,
  readArtifactBody,
  readErrorDetail,
} from "../lib/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function baseUrl(): string {
  return resolveBaseUrl();
}

function apiKey(): string {
  const k = resolveApiKey();
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
  format: AiBomFormat;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ body: string; contentType: string; suggestedFilename: string }> {
  if (!UUID_RE.test(opts.projectId)) {
    throw new Error(`projectId must be a valid v4 UUID. Got: ${opts.projectId}`);
  }
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const url = `${opts.baseUrl}/ai-sbom?projectId=${encodeURIComponent(opts.projectId)}&format=${opts.format}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      accept: opts.format === "cyclonedx" || opts.format === "spdx" ? "application/json" : "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`AI-BOM export failed: HTTP ${res.status}${await readErrorDetail(res)}`);
  }
  // FAIL CLOSED: prove these bytes are the AI-BOM route's document, in the
  // format that was asked for, BEFORE anyone can write them to disk. Throws
  // `IndeterminateResponseError` otherwise, which the action handler reports
  // and exits 1 on — with no file created.
  const body = await readArtifactBody(res, {
    endpoint: `GET /ai-sbom?format=${opts.format}`,
    format: "ai-bom",
    contract: AI_BOM_MARKERS[opts.format],
    what: "AI-BOM",
  });
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
  const fetchFn = opts.fetchImpl ?? boundedFetch;
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
    const j = (await decodeJsonBody(res, "POST /ai-sbom/generate")) as {
      error?: { message?: string; code?: string };
    } | null;
    const detail = j?.error ? ` (${j.error.code ?? "ERROR"}: ${j.error.message ?? "unknown"})` : "";
    throw new Error(`Supply-chain scan failed: HTTP ${res.status}${detail}`);
  }
  // Through the boundary rather than a bare `res.json()`: an empty body, a 204,
  // a bare `null` and a bare primitive are refused here instead of arriving as
  // `null` and being read for `.data`.
  const body = (await decodeJsonBody(res, "POST /ai-sbom/generate")) as {
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
    .option("-f, --format <fmt>", `Export format: ${AI_BOM_FORMATS.join(" | ")}`, "cyclonedx")
    .option("-o, --out <path>", "Output file path (default: ./evalguard-ai-bom-<id>.<ext>)")
    .action(
      async (
        projectId: string,
        opts: { format: string; out?: string },
      ) => {
        // Parsed against `AI_BOM_FORMATS`, which is also what `AI_BOM_MARKERS`
        // is keyed by — so the formats this command ADVERTISES and the formats
        // that have a validation contract are one list, and a fourth cannot be
        // accepted here without one existing.
        const fmt = opts.format.toLowerCase();
        if (!isAiBomFormat(fmt)) {
          console.error(
            chalk.red(`Unknown format: ${opts.format}. Choose: ${AI_BOM_FORMATS.join(" | ")}`),
          );
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
            format: fmt,
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
          // `--fail-on-errors` is NOT optional polish. Measured on
          // cyclonedx-cli 0.33.1 against a deliberately non-conformant BOM
          // (`components` an object, an extra root key):
          //
          //   $ cyclonedx validate --input-file bad.cdx.json
          //     Value is "object" but should be "array"
          //     All values fail against the false schema
          //     BOM is not valid.
          //   $ echo $?
          //     0                        ← without the flag
          //   $ cyclonedx validate --input-file bad.cdx.json --fail-on-errors
          //     … BOM is not valid.
          //   $ echo $?
          //     1                        ← with it
          //
          // A customer who pastes our printed command into a CI job gets a step
          // that prints "BOM is not valid." and then goes green — the pipeline
          // cannot fail, which is the same fail-OPEN defect this whole module
          // exists to close, just relocated into the customer's pipeline. The
          // flag costs nothing on a valid document: the same tool exits 0 on
          // the route's real export with and without it.
          console.log(
            `    • Validate: ${chalk.cyan("cyclonedx validate --fail-on-errors --input-file " + path.basename(outputPath))}`,
          );
          console.log(`    • Spec: https://cyclonedx.org/specification/overview/`);
        } else if (fmt === "spdx") {
          // No equivalent flag is needed here, and that was measured rather
          // than assumed: `pyspdxtools` (spdx-tools 0.8.x) validates by default
          // and exits NON-ZERO when it fails — 0 + silent on the route's real
          // SPDX 2.3 export, 1 + "The document is invalid" on a broken one. The
          // weak-command defect is specific to `cyclonedx validate`.
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
