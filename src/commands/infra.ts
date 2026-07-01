/**
 * `evalguard infra scan <targets...>` — AI infrastructure exposure scan.
 *
 * Probes operator-supplied hosts for exposed AI services (Ollama, vLLM, Ray,
 * MLflow, Gradio, Jupyter, Langflow, Flowise, Open WebUI, ComfyUI, TGI,
 * Triton), extracts running versions, and matches them against live OSV.dev
 * advisories. Runs entirely client-side: probes go from THIS machine to the
 * targets, and only OSV.dev is contacted externally. No EvalGuard API key
 * required.
 *
 *   evalguard infra scan 10.0.0.5 ml-box:8265 http://gpu-host:8000 \
 *     [--fail-on critical|high|medium|low] [--timeout 3000] [--no-live] [--json]
 *
 * Targets are explicit hosts (host, host:port, or http(s)://host[:port]) —
 * CIDR ranges and wildcards are rejected by design. Scan only infrastructure
 * you own or are authorized to assess.
 */
import { Command } from "commander";
import chalk from "chalk";
import type { InfraScanTarget, InfraScanFinding, InfraScanResult } from "@evalguard/core";

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

/**
 * Parse explicit scan targets. Accepts "host", "host:port" and
 * "http(s)://host[:port]"; rejects CIDR ranges, wildcards and paths so the
 * command can never become a network sweeper.
 */
export function parseInfraTargets(args: string[]): InfraScanTarget[] {
  return args.map((raw) => {
    const value = raw.trim();
    if (value.includes("*")) {
      throw new Error(`Wildcard targets are not supported: ${value}. List explicit hosts.`);
    }
    if (/\/\d{1,2}$/.test(value)) {
      throw new Error(`CIDR ranges are not supported: ${value}. List explicit hosts you are authorized to scan.`);
    }

    let scheme: "http" | "https" | undefined;
    let rest = value;
    const schemeMatch = value.match(/^(https?):\/\//);
    if (schemeMatch) {
      scheme = schemeMatch[1] as "http" | "https";
      rest = value.slice(schemeMatch[0].length);
    }
    if (rest.includes("/")) {
      throw new Error(`Target must be a host or host:port, not a URL with a path: ${value}`);
    }

    let host = rest;
    let port: number | undefined;
    const portMatch = rest.match(/^(.+):(\d{1,5})$/);
    if (portMatch) {
      host = portMatch[1];
      port = Number(portMatch[2]);
      if (port < 1 || port > 65535) throw new Error(`Invalid port in target: ${value}`);
    }
    if (!HOST_RE.test(host)) {
      throw new Error(`Invalid host in target: ${value}`);
    }
    return { host, port, scheme };
  });
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0, info: 0 };

/**
 * CI gate: fails when any CVE severity OR unauthenticated-exposure severity
 * (high) reaches the threshold.
 */
export function infraGateFails(findings: InfraScanFinding[], failOn: string): boolean {
  const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.high;
  let worst = 0;
  for (const f of findings) {
    worst = Math.max(worst, SEVERITY_RANK[f.exposureSeverity] ?? 0);
    for (const v of f.vulnerabilities) worst = Math.max(worst, SEVERITY_RANK[v.severity] ?? 0);
  }
  return worst >= threshold;
}

export function registerInfra(program: Command): void {
  const cmd = program
    .command("infra")
    .description("AI infrastructure exposure scanning (client-side)");

  cmd
    .command("scan")
    .description("Probe explicit hosts for exposed AI services + live OSV.dev CVE match")
    .argument("<targets...>", "Hosts to scan: host | host:port | http(s)://host[:port] (no CIDR — explicit, authorized hosts only)")
    .option("--fail-on <severity>", "Exit 1 at/above: critical | high | medium | low", "high")
    .option("--timeout <ms>", "Per-probe timeout in milliseconds", "3000")
    .option("--no-live", "Skip live OSV.dev CVE lookups (fingerprint + exposure only)")
    .option("--json", "Print the raw scan result as JSON")
    .action(
      async (
        targetArgs: string[],
        opts: { failOn: string; timeout: string; live: boolean; json?: boolean },
      ) => {
        const failOn = opts.failOn.toLowerCase();
        if (!["critical", "high", "medium", "low"].includes(failOn)) {
          console.error(chalk.red(`Unknown --fail-on: ${opts.failOn}. Choose: critical | high | medium | low`));
          process.exit(1);
        }
        const timeoutMs = Number(opts.timeout);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
          console.error(chalk.red(`--timeout must be 100..60000 ms, got: ${opts.timeout}`));
          process.exit(1);
        }

        let targets: InfraScanTarget[];
        try {
          targets = parseInfraTargets(targetArgs);
        } catch (err) {
          console.error(chalk.red(`  ${(err as Error).message}`));
          process.exit(1);
          return;
        }

        if (!opts.json) {
          console.log();
          console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — AI infrastructure exposure scan"));
          console.log(chalk.dim("  ─────────────────────────────────────────────"));
          console.log();
          console.log(`  Targets: ${chalk.cyan(targets.map((t) => t.port ? `${t.host}:${t.port}` : t.host).join(", "))}`);
          console.log(`  Mode:    ${chalk.cyan(opts.live ? "fingerprint + live OSV.dev CVE match" : "fingerprint only")}`);
          console.log(chalk.dim("  Scan only infrastructure you own or are authorized to assess."));
          console.log();
        }

        const { runInfraScan, OsvClient } = await import("@evalguard/core");
        let result: InfraScanResult;
        try {
          result = await runInfraScan(targets, {
            osvClient: opts.live ? new OsvClient() : null,
            timeoutMs,
          });
        } catch (err) {
          console.error(chalk.red(`  Scan failed: ${(err as Error).message}`));
          process.exit(1);
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `  Probes: ${chalk.cyan(String(result.scan.probesAttempted))}` +
            ` · Services detected: ${chalk.cyan(String(result.scan.servicesDetected))}`,
          );
          if (result.scan.liveStatus === "degraded") {
            console.log(`  ${chalk.yellow("!")} OSV lookup degraded (${result.scan.error ?? "unknown"}) — exposure results only`);
          }
          if (result.scan.truncatedAdvisoryCount > 0) {
            console.log(`  ${chalk.yellow("!")} ${result.scan.truncatedAdvisoryCount} advisories matched but not detailed (cap)`);
          }
          console.log();

          if (result.findings.length === 0) {
            console.log(`  ${chalk.green("✓")} No AI services detected on the supplied targets`);
          }
          for (const f of result.findings) {
            const where = `${f.scheme}://${f.host}:${f.port}`;
            const auth = f.unauthenticated
              ? chalk.red("UNAUTHENTICATED")
              : chalk.green("auth enforced");
            console.log(`  ${chalk.bold(f.displayName)} ${chalk.dim(where)}  version=${chalk.cyan(f.version ?? "unknown")}  ${auth}`);
            console.log(chalk.dim(`    evidence: ${f.evidence} · ${f.exposureNote}`));
            if (f.cveSource === "osv") {
              if (f.vulnerabilities.length === 0) {
                console.log(`    ${chalk.green("✓")} no known OSV advisories for this version`);
              } else {
                for (const v of f.vulnerabilities.slice(0, 8)) {
                  const fix = v.fixedVersion ? chalk.green(` → fix: ${v.fixedVersion}`) : "";
                  console.log(`    ${chalk.red(v.cveId)} [${v.severity}]${fix}`);
                }
                if (f.vulnerabilities.length > 8) {
                  console.log(chalk.dim(`    … and ${f.vulnerabilities.length - 8} more (use --json for all)`));
                }
              }
            } else if (f.version) {
              console.log(chalk.dim(`    no OSV package mapping for ${f.displayName} — review vendor advisories manually`));
            } else {
              console.log(chalk.dim(`    version not exposed — CVE match skipped`));
            }
            console.log();
          }
        }

        if (infraGateFails(result.findings, failOn)) {
          if (!opts.json) console.error(chalk.red(`  ✗ Gate failed: findings at or above "${failOn}"`));
          process.exit(1);
        }
        if (!opts.json) console.log(`  ${chalk.green("✓")} Gate passed (--fail-on ${failOn})`);
      },
    );
}
