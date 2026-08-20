/**
 * `evalguard evaluators` — versioned, reusable evaluator registry (Evaluator Hub).
 *
 *   evalguard evaluators list --project <id> [--name <n>] [--json]
 *   evalguard evaluators diff --project <id> --name <n> --from <v> --to <v> [--json]
 *
 * The API-calling functions take an injectable `fetchImpl` so they're unit-
 * testable offline (mirrors ai-bom.ts). The commander wrapper supplies the real
 * fetch + env config.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { failExit } from "../lib/poll.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectArray,
  unwrapApiEnvelope,
} from "../lib/http.js";

export interface EvaluatorsApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function call(path: string, init: RequestInit, opts: EvaluatorsApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? boundedFetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function listEvaluators(
  args: { projectId: string; name?: string } & EvaluatorsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId });
  if (args.name) qs.set("name", args.name);
  return call(`/evaluators?${qs.toString()}`, { method: "GET" }, args);
}

export async function diffEvaluators(
  args: { projectId: string; name: string; fromVersion: number; toVersion: number } & EvaluatorsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  return call(
    `/evaluators/diff`,
    {
      method: "POST",
      body: JSON.stringify({
        projectId: args.projectId,
        name: args.name,
        fromVersion: args.fromVersion,
        toVersion: args.toVersion,
      }),
    },
    args,
  );
}

function envConfig(): EvaluatorsApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

export function registerEvaluators(program: Command): void {
  const cmd = program
    .command("evaluators")
    .description("Versioned, reusable evaluator registry (Evaluator Hub)");

  cmd
    .command("list")
    .description("List evaluators (all versions; pass --name for one evaluator's history)")
    .requiredOption("--project <id>", "Project UUID")
    .option("--name <name>", "Filter to one evaluator's version history")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; name?: string; json?: boolean }) => {
      try {
        const body = await listEvaluators({
          projectId: opts.project,
          name: opts.name,
          ...envConfig(),
        });
        // `body.data ?? []` printed "No evaluators found." and exited 0 for a
        // 200 carrying an unrelated object — measured 2026-08-08.
        const rows = expectArray(
          unwrapApiEnvelope(body, "GET /evaluators"),
          "GET /evaluators",
        ) as Array<Record<string, unknown>>;
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("  No evaluators found."));
          return;
        }
        console.log(chalk.bold(`\n  Evaluators (${rows.length})\n`));
        for (const r of rows) {
          const active = r.is_active ? chalk.green("●") : chalk.dim("○");
          console.log(
            `  ${active} ${String(r.name).padEnd(28)} v${r.version}  ${chalk.dim(String(r.kind))}`,
          );
        }
        console.log();
      } catch (e) {
        failExit(chalk.red(`evaluators list failed: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
    });

  cmd
    .command("diff")
    .description("Field-level diff between two versions of an evaluator")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--name <name>", "Evaluator name")
    .requiredOption("--from <v>", "From version", (v) => parseInt(v, 10))
    .requiredOption("--to <v>", "To version", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; name: string; from: number; to: number; json?: boolean }) => {
      try {
        const body = (await diffEvaluators({
          projectId: opts.project,
          name: opts.name,
          fromVersion: opts.from,
          toVersion: opts.to,
          ...envConfig(),
        })) as { data?: { diff?: { changed: boolean; added: string[]; removed: string[]; modified: string[] } } };
        const diff = body.data?.diff;
        if (opts.json) {
          console.log(JSON.stringify(body.data, null, 2));
          return;
        }
        if (!diff || !diff.changed) {
          console.log(chalk.dim(`  No changes between ${opts.name} v${opts.from} and v${opts.to}.`));
          return;
        }
        console.log(chalk.bold(`\n  ${opts.name}: v${opts.from} -> v${opts.to}\n`));
        for (const k of diff.added) console.log(`  ${chalk.green("+")} ${k}`);
        for (const k of diff.removed) console.log(`  ${chalk.red("-")} ${k}`);
        for (const k of diff.modified) console.log(`  ${chalk.yellow("~")} ${k}`);
        console.log();
      } catch (e) {
        console.error(chalk.red(`evaluators diff failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
