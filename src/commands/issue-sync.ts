/**
 * `evalguard issue-sync …` — idempotent security-finding → bug-tracker sync (G5).
 *
 * Sync a project's security findings to GitHub Issues / Jira as DEDUPED issues:
 * each finding maps to ONE tracker issue via a stable fingerprint (CVE/rule +
 * file), so re-syncing UPDATES the same issue instead of opening a duplicate,
 * and a finding marked resolved (or absent) CLOSES its issue.
 *
 *   evalguard issue-sync --project <id> --provider github --file findings.json
 *   evalguard issue-sync --project <id> --provider jira   --file findings.json --json
 *
 * findings.json is a JSON array of findings:
 *   [{ "cveId": "CVE-2024-1", "file": "lodash@4.17.20", "title": "Proto pollution",
 *      "severity": "high", "description": "...", "status": "open" }]
 *
 * Hits /api/v1/integrations/issue-sync with the user's API key. Owner/admin on
 * the project's org only. The tracker token comes from the org's integration
 * config (configured via the dashboard) — never the CLI.
 */
import { Command } from "commander";
import chalk from "chalk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}

function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login --key <key>` first."));
    process.exit(1);
  }
  return k;
}

export interface IssueSyncFindingInput {
  vulnId?: string;
  cveId?: string;
  rule?: string;
  file?: string;
  title: string;
  description?: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  remediation?: string;
  references?: string[];
  status?: "open" | "resolved";
}

export interface IssueSyncResponse {
  provider: "github" | "jira";
  createdCount: number;
  updatedCount: number;
  closedCount: number;
  errorCount: number;
  created: { fingerprint: string; externalIssueId: string; externalUrl?: string }[];
  updated: { fingerprint: string; externalIssueId: string }[];
  closed: { fingerprint: string; externalIssueId: string }[];
  errors: { fingerprint: string; op: string; message: string }[];
}

export interface IssueSyncApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** POST findings to the sync endpoint. Pure-ish (injectable fetch) so the
 *  request shaping is unit-testable offline (mirrors agent-tools.ts). */
export async function syncIssues(
  args: {
    projectId: string;
    provider: "github" | "jira";
    findings: IssueSyncFindingInput[];
  } & IssueSyncApiOpts,
): Promise<IssueSyncResponse> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (args.provider !== "github" && args.provider !== "jira") {
    throw new Error('provider must be "github" or "jira"');
  }
  if (!Array.isArray(args.findings) || args.findings.length === 0) {
    throw new Error("findings must be a non-empty array");
  }
  const f = args.fetchImpl ?? fetch;
  const res = await f(`${args.baseUrl}/integrations/issue-sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({ projectId: args.projectId, provider: args.provider, findings: args.findings }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch {
      msg = `${msg}: ${text.slice(0, 300)}`;
    }
    throw new Error(msg);
  }
  const json = text ? (JSON.parse(text) as { data?: IssueSyncResponse }) : {};
  return (json.data ?? (json as IssueSyncResponse));
}

async function readFindingsFile(file: string): Promise<IssueSyncFindingInput[]> {
  const fs = await import("node:fs");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Failed to read/parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of findings`);
  return parsed as IssueSyncFindingInput[];
}

export function registerIssueSync(program: Command): void {
  program
    .command("issue-sync")
    .description("Sync security findings to GitHub Issues / Jira as deduped issues (G5)")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--provider <provider>", "github | jira")
    .requiredOption("--file <path>", "JSON file: an array of findings")
    .option("--json", "output raw JSON", false)
    .action(async (opts: { project: string; provider: string; file: string; json?: boolean }) => {
      try {
        if (opts.provider !== "github" && opts.provider !== "jira") {
          throw new Error('--provider must be "github" or "jira"');
        }
        const findings = await readFindingsFile(opts.file);
        const result = await syncIssues({
          projectId: opts.project,
          provider: opts.provider,
          findings,
          baseUrl: baseUrl(),
          apiKey: apiKey(),
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `${chalk.green("✓")} Synced ${findings.length} finding(s) to ${chalk.cyan(result.provider)}: ` +
            `${chalk.green(`${result.createdCount} created`)} ${chalk.dim("·")} ` +
            `${result.updatedCount} updated ${chalk.dim("·")} ${result.closedCount} closed` +
            (result.errorCount > 0 ? ` ${chalk.dim("·")} ${chalk.red(`${result.errorCount} errors`)}` : ""),
        );
        for (const c of result.created) {
          console.log(`  ${chalk.green("+")} ${chalk.dim(c.fingerprint)} → #${c.externalIssueId}${c.externalUrl ? chalk.dim(` ${c.externalUrl}`) : ""}`);
        }
        for (const c of result.closed) {
          console.log(`  ${chalk.yellow("✓")} ${chalk.dim(c.fingerprint)} closed #${c.externalIssueId}`);
        }
        if (result.errorCount > 0) {
          console.log(chalk.bold(chalk.red("\nErrors:")));
          for (const e of result.errors) console.log(`  ${chalk.red("✗")} ${chalk.dim(e.fingerprint)} (${e.op}): ${e.message}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(chalk.red("✗ ") + (err as Error).message);
        process.exit(1);
      }
    });
}
