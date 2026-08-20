/**
 * `evalguard sbom-monitor …` — continuous SBOM re-scan + new-CVE alerting (G1).
 *
 * Enable a project for continuous monitoring: the worker re-runs the
 * supply-chain scan every 24h, diffs vs the last snapshot, and alerts when a
 * NEW KEV-listed / high-EPSS CVE is disclosed against a dependency you already
 * ship — the gap a one-shot scan can't see.
 *
 *   evalguard sbom-monitor enable  --project <id> [--epss 0.5] [--no-kev]
 *   evalguard sbom-monitor disable --project <id>
 *   evalguard sbom-monitor list    --project <id> [--json]
 *   evalguard sbom-monitor run     --project <id> [--json]
 *
 * Hits /api/v1/sbom-monitor (+ /run) with the user's API key. enable/disable/run
 * require owner/admin on the project's org.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { failExit } from "../lib/poll.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectArrayField,
  expectField,
  unwrapApiEnvelope,
} from "../lib/http.js";

function baseUrl(): string {
  return resolveBaseUrl();
}

function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login --key <key>` first."));
    process.exit(1);
  }
  return k;
}

interface MonitorRecord {
  id: string;
  orgId: string;
  projectId: string;
  enabled: boolean;
  epssThreshold: number;
  alertOnKev: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SnapshotSummary {
  id: string;
  dayKey: string;
  vulnCount: number;
  kevCount: number;
  highEpssCount: number;
  scannedAt: string;
}

interface AlertableCve {
  cveId: string;
  affectedPackage: string;
  severity: string;
  epssScore: number | null;
  kevListed: boolean;
}

interface RunResult {
  projectId: string;
  vulnCount: number;
  kevCount: number;
  highEpssCount: number;
  newVulns: AlertableCve[];
  alertable: AlertableCve[];
  scanMode: string;
  liveStatus: string;
  scannedAt: string;
}

async function apiFetch<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await boundedFetch(`${baseUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  // FAIL CLOSED. This used to hand-roll its own decode:
  //
  //     const text = await res.text();
  //     const json = text ? JSON.parse(text) : {};
  //     return (json.data ?? json) as T;
  //
  // which is the fail-open with the serial numbers filed off — an EMPTY body
  // (and a 204) became `{}`, and `{}` then read as "no SBOM monitor configured".
  // Measured 2026-08-08: `evalguard sbom-monitor status` exited 0 with
  // "No SBOM monitor configured for this project." against a 204, an empty
  // body, `{"hello":"world"}`, `{success:true,data:null}`, a `success:false`
  // envelope AND a bare `"ok"` — six of the twelve cases in the matrix, the
  // worst row in the CLI.
  //
  // It also slipped past `__tests__/http-boundary-gate.test.ts`, which banned
  // `fetch(` and `.json().catch(` but not a hand-written `res.text()` +
  // `JSON.parse`. The gate now scans for this shape too.
  if (!res.ok) {
    const body = await decodeJsonBody(res, path);
    const detail = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return unwrapApiEnvelope(await decodeJsonBody(res, path), path) as T;
}

function fmtCve(c: AlertableCve): string {
  const tag = c.kevListed
    ? chalk.red("KEV")
    : c.epssScore != null
      ? chalk.yellow(`EPSS ${(c.epssScore * 100).toFixed(0)}%`)
      : c.severity;
  return `${chalk.cyan(c.cveId)} ${chalk.dim("·")} ${c.affectedPackage} ${chalk.dim("·")} ${tag}`;
}

export function registerSbomMonitor(program: Command): void {
  const cmd = program
    .command("sbom-monitor")
    .description("Continuously re-scan a project's SBOM and alert on newly-disclosed CVEs (G1)");

  cmd
    .command("enable")
    .description("Enable continuous SBOM monitoring for a project")
    .requiredOption("--project <id>", "Project UUID")
    .option("--epss <n>", "EPSS alert threshold 0..1 (default 0.5)")
    .option("--no-kev", "Do NOT alert on CISA KEV-listed CVEs (default: do alert)")
    .action(async (opts: { project: string; epss?: string; kev?: boolean }) => {
      try {
        const body: Record<string, unknown> = { projectId: opts.project, enabled: true };
        if (opts.epss !== undefined) body.epssThreshold = Number(opts.epss);
        // commander sets opts.kev=false when --no-kev is passed; leave default otherwise.
        if (opts.kev === false) body.alertOnKev = false;
        const { monitor } = await apiFetch<{ monitor: MonitorRecord }>("/sbom-monitor", "POST", body);
        console.log(
          `${chalk.green("✓")} SBOM monitoring enabled for ${chalk.cyan(monitor.projectId)} ` +
            chalk.dim(`(EPSS >= ${monitor.epssThreshold}${monitor.alertOnKev ? ", KEV on" : ", KEV off"})`),
        );
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command("disable")
    .description("Disable continuous SBOM monitoring for a project")
    .requiredOption("--project <id>", "Project UUID")
    .action(async (opts: { project: string }) => {
      try {
        await apiFetch<{ monitor: MonitorRecord }>("/sbom-monitor", "POST", {
          projectId: opts.project,
          enabled: false,
        });
        console.log(`${chalk.green("✓")} SBOM monitoring disabled for ${chalk.cyan(opts.project)}`);
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("Show a project's monitor config + recent snapshots")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "output raw JSON")
    .action(async (opts: { project: string; json?: boolean }) => {
      try {
        const raw = await apiFetch<unknown>(
          `/sbom-monitor?projectId=${encodeURIComponent(opts.project)}`,
          "GET",
        );
        // The route always sends BOTH keys; `monitor` may legitimately be null
        // ("not configured"), `snapshots` may legitimately be empty. What must
        // not pass is a body carrying neither — `!result.monitor` on an
        // unrelated 200 printed "No SBOM monitor configured" and exited 0.
        const endpoint = "GET /sbom-monitor";
        const result = {
          monitor: expectField(raw, "monitor", endpoint) as MonitorRecord | null,
          snapshots: expectArrayField(raw, "snapshots", endpoint) as SnapshotSummary[],
        };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.monitor) {
          console.log(chalk.dim("No SBOM monitor configured for this project. Run `sbom-monitor enable`."));
          return;
        }
        const m = result.monitor;
        console.log(
          `${m.enabled ? chalk.green("● enabled") : chalk.dim("○ disabled")} ${chalk.dim("·")} ` +
            `EPSS >= ${m.epssThreshold} ${chalk.dim("·")} ${m.alertOnKev ? "KEV on" : "KEV off"} ${chalk.dim("·")} ` +
            (m.lastRunAt ? `last run ${m.lastRunAt}` : chalk.dim("never run")),
        );
        if (result.snapshots.length === 0) {
          console.log(chalk.dim("No snapshots yet."));
          return;
        }
        console.log(chalk.dim("\nRecent snapshots:"));
        for (const s of result.snapshots) {
          console.log(
            `  ${s.dayKey} ${chalk.dim("·")} ${s.vulnCount} vulns ${chalk.dim("·")} ` +
              `${chalk.red(`${s.kevCount} KEV`)} ${chalk.dim("·")} ${chalk.yellow(`${s.highEpssCount} high-EPSS`)}`,
          );
        }
      } catch (err) {
        failExit(chalk.red("✗ ") + (err as Error).message);
        return;
      }
    });

  cmd
    .command("run")
    .description("Re-scan a project NOW and show the diff vs the last snapshot")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "output raw JSON")
    .action(async (opts: { project: string; json?: boolean }) => {
      try {
        const result = await apiFetch<RunResult>("/sbom-monitor/run", "POST", { projectId: opts.project });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `${chalk.green("✓")} Scanned ${chalk.cyan(result.projectId)} ${chalk.dim(`(${result.scanMode}/${result.liveStatus})`)}: ` +
            `${result.vulnCount} vulns, ${chalk.red(`${result.kevCount} KEV`)}, ${chalk.yellow(`${result.highEpssCount} high-EPSS`)}`,
        );
        if (result.newVulns.length === 0) {
          console.log(chalk.dim("No newly-disclosed CVEs since the last snapshot."));
          return;
        }
        console.log(chalk.bold(`\n${result.newVulns.length} newly-disclosed CVE(s):`));
        for (const c of result.newVulns) console.log(`  ${fmtCve(c)}`);
        if (result.alertable.length > 0) {
          console.log(
            chalk.bold(`\n${result.alertable.length} alert-worthy (KEV or EPSS over threshold) — would notify owners/admins.`),
          );
        }
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
      }
    });
}
