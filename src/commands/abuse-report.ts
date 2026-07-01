/**
 * `evalguard abuse-report` — defense-in-depth abuse-report intake.
 *
 *   evalguard abuse-report report --project <id> --category <c> [--description <d>]
 *                                 [--subject <id>] [--reporter <id>] [--evidence <json|@file>] [--json]
 *   evalguard abuse-report list   --project <id> [--status <s>] [--json]
 *
 * `report` files a new report and prints the server-side triage verdict
 * (severity / dedupKey / autoEscalate / feedToDetector / reasons). `list`
 * shows existing reports, optionally filtered by status.
 *
 * The API-calling functions take an injectable `fetchImpl` so they're unit-
 * testable offline (mirrors evaluators.ts / ai-bom.ts). The commander wrapper
 * supplies the real fetch + env config.
 */
import { Command } from "commander";
import chalk from "chalk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ABUSE_CATEGORIES = [
  "csam",
  "violence",
  "self_harm",
  "harassment",
  "hate",
  "fraud",
  "privacy",
  "spam",
  "other",
] as const;
export type AbuseCategory = (typeof ABUSE_CATEGORIES)[number];

export const ABUSE_STATUSES = ["open", "reviewing", "actioned", "dismissed"] as const;
export type AbuseStatus = (typeof ABUSE_STATUSES)[number];

export interface AbuseTriage {
  severity: string;
  category: string;
  dedupKey: string;
  autoEscalate: boolean;
  feedToDetector: boolean;
  reasons: string[];
}

export interface AbuseReportsApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: AbuseReportsApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function listAbuseReports(
  args: { projectId: string; status?: AbuseStatus } & AbuseReportsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId });
  if (args.status) qs.set("status", args.status);
  return call(`/abuse-reports?${qs.toString()}`, { method: "GET" }, args);
}

export async function fileAbuseReport(
  args: {
    projectId: string;
    category: AbuseCategory;
    description?: string;
    subjectId?: string;
    reporterId?: string;
    evidence?: unknown;
  } & AbuseReportsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!ABUSE_CATEGORIES.includes(args.category)) {
    throw new Error(`category must be one of: ${ABUSE_CATEGORIES.join(" | ")}`);
  }
  const payload: Record<string, unknown> = { projectId: args.projectId, category: args.category };
  if (args.description !== undefined) payload.description = args.description;
  if (args.subjectId !== undefined) payload.subjectId = args.subjectId;
  if (args.reporterId !== undefined) payload.reporterId = args.reporterId;
  if (args.evidence !== undefined) payload.evidence = args.evidence;
  return call(`/abuse-reports`, { method: "POST", body: JSON.stringify(payload) }, args);
}

function envConfig(): AbuseReportsApiOpts {
  const apiKey = process.env.EVALGUARD_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1", apiKey };
}

/** Parse the `--evidence` value: inline JSON, or `@path` to a JSON file. */
async function parseEvidence(raw: string): Promise<unknown> {
  let text = raw;
  if (raw.startsWith("@")) {
    const fs = await import("node:fs");
    try {
      text = fs.readFileSync(raw.slice(1), "utf8");
    } catch (e) {
      console.error(chalk.red(`Failed to read ${raw.slice(1)}: ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    console.error(chalk.red(`--evidence must be valid JSON (or @file): ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

function severityColor(severity: string): (s: string) => string {
  switch (severity.toLowerCase()) {
    case "critical":
      return chalk.red.bold;
    case "high":
      return chalk.red;
    case "medium":
      return chalk.yellow;
    default:
      return chalk.dim;
  }
}

export function registerAbuseReport(program: Command): void {
  const cmd = program
    .command("abuse-report")
    .description("File and review abuse reports (defense-in-depth intake)");

  // ─── abuse-report report ────────────────────────────────────────────
  cmd
    .command("report")
    .description("File an abuse report and print the triage verdict")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--category <category>", `One of: ${ABUSE_CATEGORIES.join(" | ")}`)
    .option("--description <text>", "Free-text description of the abuse")
    .option("--subject <id>", "Identifier of the offending subject")
    .option("--reporter <id>", "Identifier of the reporter")
    .option("--evidence <json>", "Evidence as inline JSON, or @path to a JSON file")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        project: string;
        category: string;
        description?: string;
        subject?: string;
        reporter?: string;
        evidence?: string;
        json?: boolean;
      }) => {
        try {
          if (!ABUSE_CATEGORIES.includes(opts.category as AbuseCategory)) {
            console.error(chalk.red(`Unknown category: ${opts.category}. Choose: ${ABUSE_CATEGORIES.join(" | ")}`));
            process.exit(1);
          }
          const evidence = opts.evidence !== undefined ? await parseEvidence(opts.evidence) : undefined;
          const body = (await fileAbuseReport({
            projectId: opts.project,
            category: opts.category as AbuseCategory,
            description: opts.description,
            subjectId: opts.subject,
            reporterId: opts.reporter,
            evidence,
            ...envConfig(),
          })) as { data?: { report?: Record<string, unknown>; triage?: AbuseTriage } };
          const data = body.data ?? (body as { report?: Record<string, unknown>; triage?: AbuseTriage });
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          const report = data.report ?? {};
          const triage = data.triage;
          console.log(chalk.green(`  ✓ Filed abuse report${report.id ? ` ${chalk.cyan(String(report.id))}` : ""}`));
          if (triage) {
            const color = severityColor(triage.severity);
            console.log();
            console.log(`  ${chalk.dim("severity:       ")} ${color(triage.severity)}`);
            console.log(`  ${chalk.dim("category:       ")} ${triage.category}`);
            console.log(`  ${chalk.dim("dedup key:      ")} ${triage.dedupKey}`);
            console.log(`  ${chalk.dim("auto-escalate:  ")} ${triage.autoEscalate ? chalk.yellow("YES") : "no"}`);
            console.log(`  ${chalk.dim("feed detector:  ")} ${triage.feedToDetector ? chalk.green("yes") : "no"}`);
            if (triage.reasons.length > 0) {
              console.log(`  ${chalk.dim("reasons:")}`);
              for (const r of triage.reasons) console.log(`    ${chalk.dim("•")} ${r}`);
            }
          }
          console.log();
        } catch (e) {
          console.error(chalk.red(`abuse-report report failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );

  // ─── abuse-report list ──────────────────────────────────────────────
  cmd
    .command("list")
    .description("List abuse reports for a project (optionally filter by status)")
    .requiredOption("--project <id>", "Project UUID")
    .option("--status <status>", `Filter by status: ${ABUSE_STATUSES.join(" | ")}`)
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; status?: string; json?: boolean }) => {
      try {
        if (opts.status && !ABUSE_STATUSES.includes(opts.status as AbuseStatus)) {
          console.error(chalk.red(`Unknown status: ${opts.status}. Choose: ${ABUSE_STATUSES.join(" | ")}`));
          process.exit(1);
        }
        const body = (await listAbuseReports({
          projectId: opts.project,
          status: opts.status as AbuseStatus | undefined,
          ...envConfig(),
        })) as { data?: { reports?: Array<Record<string, unknown>> } };
        const reports = body.data?.reports ?? [];
        if (opts.json) {
          console.log(JSON.stringify(reports, null, 2));
          return;
        }
        if (reports.length === 0) {
          console.log(chalk.dim("  No abuse reports found."));
          return;
        }
        console.log(chalk.bold(`\n  Abuse reports (${reports.length})\n`));
        for (const r of reports) {
          const severity = String(r.severity ?? "");
          const color = severityColor(severity);
          const status = String(r.status ?? "open");
          console.log(
            `  ${color(severity.padEnd(9))} ${String(r.category ?? "").padEnd(12)} ${chalk.dim(status.padEnd(10))} ${chalk.dim(String(r.id ?? ""))}`,
          );
        }
        console.log();
      } catch (e) {
        console.error(chalk.red(`abuse-report list failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
