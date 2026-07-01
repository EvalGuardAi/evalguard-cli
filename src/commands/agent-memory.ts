/**
 * `evalguard agent-memory` — two-tier agent memory (long-term semantic recall).
 *
 *   evalguard agent-memory remember --project <id> --session <key> --fact "..." [--fact "..."]
 *   evalguard agent-memory remember --project <id> --session <key> --facts-file facts.json
 *   evalguard agent-memory recall   --project <id> --session <key> [--query "..."] [--limit 5]
 *   evalguard agent-memory forget   --project <id> --session <key>
 *
 * The API functions take an injectable `fetchImpl` so they're unit-testable
 * offline (mirrors agent-tools.ts). Output unwraps the { success, data } envelope.
 */
import { Command } from "commander";
import chalk from "chalk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: MemoryApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function rememberMemory(
  args: { projectId: string; sessionKey: string; facts?: string[]; agentId?: string } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.sessionKey) throw new Error("sessionKey is required");
  if (!args.facts?.length) throw new Error("at least one --fact (or --facts-file) is required");
  return call(
    "/agent-memory",
    { method: "POST", body: JSON.stringify({ projectId: args.projectId, sessionKey: args.sessionKey, facts: args.facts, agentId: args.agentId }) },
    args,
  );
}

export async function recallMemory(
  args: { projectId: string; sessionKey: string; query?: string; limit?: number } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.sessionKey) throw new Error("sessionKey is required");
  const q = new URLSearchParams({ projectId: args.projectId, sessionKey: args.sessionKey });
  if (args.query) q.set("query", args.query);
  if (args.limit != null) q.set("limit", String(args.limit));
  return call(`/agent-memory?${q.toString()}`, { method: "GET" }, args);
}

export async function forgetMemory(
  args: { projectId: string; sessionKey: string } & MemoryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.sessionKey) throw new Error("sessionKey is required");
  const q = new URLSearchParams({ projectId: args.projectId, sessionKey: args.sessionKey });
  return call(`/agent-memory?${q.toString()}`, { method: "DELETE" }, args);
}

function envConfig(): MemoryApiOpts {
  const apiKey = process.env.EVALGUARD_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1", apiKey };
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export function registerAgentMemory(program: Command): void {
  const cmd = program.command("agent-memory").description("Two-tier agent memory — long-term semantic remember/recall/forget");

  cmd
    .command("remember")
    .description("Store durable facts for a session (deduped + embedded)")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--session <key>", "Session key (e.g. a user id)")
    .option("--fact <text>", "A fact to remember (repeatable)", collect, [])
    .option("--facts-file <path>", "JSON file with an array of fact strings")
    .option("--agent <id>", "Originating agent id")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; session: string; fact: string[]; factsFile?: string; agent?: string; json?: boolean }) => {
      try {
        let facts = opts.fact ?? [];
        if (opts.factsFile) {
          const fs = await import("node:fs");
          const parsed = JSON.parse(fs.readFileSync(opts.factsFile, "utf8"));
          if (!Array.isArray(parsed)) throw new Error("--facts-file must contain a JSON array of strings");
          facts = [...facts, ...parsed.filter((x): x is string => typeof x === "string")];
        }
        const body = (await rememberMemory({ projectId: opts.project, sessionKey: opts.session, facts, agentId: opts.agent, ...envConfig() })) as {
          data?: { written: string[]; skipped: string[] };
        };
        const result = body.data ?? (body as unknown as { written: string[]; skipped: string[] });
        if (opts.json) return void console.log(JSON.stringify(result, null, 2));
        console.log(chalk.green(`  ✓ Remembered ${result.written.length} fact(s)`) + (result.skipped.length ? chalk.dim(`, ${result.skipped.length} skipped as duplicates`) : ""));
      } catch (e) {
        console.error(chalk.red(`agent-memory remember failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("recall")
    .description("Recall a session's memory by semantic similarity to a query")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--session <key>", "Session key")
    .option("--query <text>", "Query to recall against (omit to list recent)")
    .option("--limit <n>", "Max results", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; session: string; query?: string; limit?: number; json?: boolean }) => {
      try {
        const body = (await recallMemory({ projectId: opts.project, sessionKey: opts.session, query: opts.query, limit: opts.limit, ...envConfig() })) as {
          data?: { semantic: { content: string; score: number | null }[] };
        };
        const hits = body.data?.semantic ?? [];
        if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
        if (hits.length === 0) return void console.log(chalk.dim("  No memory recalled."));
        console.log(chalk.bold(`\n  Recalled ${hits.length} memory item(s)\n`));
        for (const h of hits) {
          const score = h.score != null ? chalk.dim(` (${h.score.toFixed(3)})`) : "";
          console.log(`  • ${h.content}${score}`);
        }
        console.log();
      } catch (e) {
        console.error(chalk.red(`agent-memory recall failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("forget")
    .description("Forget a session's long-term memory")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--session <key>", "Session key")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; session: string; json?: boolean }) => {
      try {
        const body = (await forgetMemory({ projectId: opts.project, sessionKey: opts.session, ...envConfig() })) as { data?: { forgotten: number } };
        const forgotten = body.data?.forgotten ?? 0;
        if (opts.json) return void console.log(JSON.stringify({ forgotten }, null, 2));
        console.log(chalk.green(`  ✓ Forgot ${forgotten} memory item(s)`));
      } catch (e) {
        console.error(chalk.red(`agent-memory forget failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
