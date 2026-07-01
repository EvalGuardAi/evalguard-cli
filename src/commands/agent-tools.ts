/**
 * `evalguard agent-tools` — the agent tool builder (headline agent-builder
 * feature). Full CRUD plus a dry-run `test` against /api/v1/agent-tools.
 *
 *   evalguard agent-tools list   --project <id> [--json]
 *   evalguard agent-tools create --project <id> --file <tool.json> [--json]
 *   evalguard agent-tools create --project <id> --name <n> --type <t> --url <u> [...] [--json]
 *   evalguard agent-tools get    --project <id> <id> [--json]
 *   evalguard agent-tools delete --project <id> <id> [--json]
 *   evalguard agent-tools test   --project <id> <id> --args <json|@file> [--json]
 *
 * The API-calling functions take an injectable `fetchImpl` so they're unit-
 * testable offline (mirrors evaluators.ts / ai-bom.ts). The commander wrapper
 * supplies the real fetch + env config.
 */
import { Command } from "commander";
import chalk from "chalk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentToolType = "rest" | "code" | "mcp";

export interface AgentToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface AgentToolRest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  auth?: { type: string; header?: string; value?: string };
  bodyTemplate?: string;
  timeoutMs?: number;
}

export interface AgentToolCode {
  source: string;
  timeoutMs?: number;
}

export interface AgentToolMcp {
  server: string;
  toolName?: string;
}

export interface AgentTool {
  id?: string;
  name: string;
  description?: string;
  type: AgentToolType;
  parameters: AgentToolParameters;
  rest?: AgentToolRest;
  code?: AgentToolCode;
  mcp?: AgentToolMcp;
  hasSecret?: boolean;
}

export interface AgentToolTestResult {
  ok: boolean;
  stage: string;
  status?: number;
  body?: unknown;
  issues?: string[];
  message?: string;
}

export interface AgentToolsApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: AgentToolsApiOpts): Promise<unknown> {
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

export async function listAgentTools(
  args: { projectId: string } & AgentToolsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId });
  return call(`/agent-tools?${qs.toString()}`, { method: "GET" }, args);
}

export async function createAgentTool(
  args: { projectId: string; tool: AgentTool } & AgentToolsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  return call(
    `/agent-tools`,
    { method: "POST", body: JSON.stringify({ projectId: args.projectId, tool: args.tool }) },
    args,
  );
}

export async function getAgentTool(
  args: { projectId: string; id: string } & AgentToolsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId });
  return call(`/agent-tools/${encodeURIComponent(args.id)}?${qs.toString()}`, { method: "GET" }, args);
}

export async function deleteAgentTool(
  args: { projectId: string; id: string } & AgentToolsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ projectId: args.projectId });
  return call(`/agent-tools/${encodeURIComponent(args.id)}?${qs.toString()}`, { method: "DELETE" }, args);
}

export async function testAgentTool(
  args: { projectId: string; id: string; toolArgs: Record<string, unknown> } & AgentToolsApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  return call(
    `/agent-tools/${encodeURIComponent(args.id)}/test`,
    { method: "POST", body: JSON.stringify({ projectId: args.projectId, args: args.toolArgs }) },
    args,
  );
}

function envConfig(): AgentToolsApiOpts {
  const apiKey = process.env.EVALGUARD_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1", apiKey };
}

/** Read+parse a JSON file, or exit(1) with a readable message (mirrors `datasets health`). */
async function readJsonFile(file: string): Promise<unknown> {
  const fs = await import("node:fs");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(chalk.red(`Failed to read/parse ${file}: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

/**
 * Build an AgentTool from individual flags when no --file is supplied. Pure +
 * exported so the flag→tool translation is unit-testable. Throws on invalid
 * combinations (e.g. type=rest with no --url).
 */
export function buildAgentToolFromFlags(opts: {
  name?: string;
  description?: string;
  type?: string;
  url?: string;
  method?: string;
  source?: string;
  server?: string;
  toolName?: string;
  parameters?: string;
}): AgentTool {
  if (!opts.name) throw new Error("--name is required when not using --file");
  const type = (opts.type ?? "rest") as AgentToolType;
  if (type !== "rest" && type !== "code" && type !== "mcp") {
    throw new Error(`--type must be one of rest|code|mcp (got ${opts.type})`);
  }
  let parameters: AgentToolParameters = { type: "object", properties: {} };
  if (opts.parameters) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.parameters);
    } catch (e) {
      throw new Error(`--parameters must be valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const p = parsed as Partial<AgentToolParameters>;
    parameters = { type: "object", properties: p.properties ?? {}, ...(p.required ? { required: p.required } : {}) };
  }
  const tool: AgentTool = { name: opts.name, type, parameters };
  if (opts.description) tool.description = opts.description;
  if (type === "rest") {
    if (!opts.url) throw new Error("--url is required for --type rest");
    tool.rest = { method: opts.method ?? "GET", url: opts.url };
  } else if (type === "code") {
    if (!opts.source) throw new Error("--source is required for --type code");
    tool.code = { source: opts.source };
  } else {
    if (!opts.server) throw new Error("--server is required for --type mcp");
    tool.mcp = { server: opts.server, ...(opts.toolName ? { toolName: opts.toolName } : {}) };
  }
  return tool;
}

/** Parse the `--args` value: inline JSON, or `@path` to a JSON file. */
async function parseToolArgs(raw: string): Promise<Record<string, unknown>> {
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
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("args must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    console.error(chalk.red(`--args must be a JSON object (or @file): ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

function printTool(t: AgentTool): void {
  const secret = t.hasSecret ? chalk.yellow(" [secret]") : "";
  console.log();
  console.log(chalk.bold(`  ${t.name}`) + chalk.dim(` (${t.type})`) + secret);
  if (t.id) console.log(`  ${chalk.dim("id:         ")} ${t.id}`);
  if (t.description) console.log(`  ${chalk.dim("description:")} ${t.description}`);
  const required = t.parameters?.required ?? [];
  const props = Object.keys(t.parameters?.properties ?? {});
  console.log(`  ${chalk.dim("parameters: ")} ${props.length} (${required.length} required)`);
  if (t.type === "rest" && t.rest) console.log(`  ${chalk.dim("endpoint:   ")} ${t.rest.method} ${t.rest.url}`);
  if (t.type === "mcp" && t.mcp) console.log(`  ${chalk.dim("mcp server: ")} ${t.mcp.server}${t.mcp.toolName ? ` / ${t.mcp.toolName}` : ""}`);
  console.log();
}

export function registerAgentTools(program: Command): void {
  const cmd = program
    .command("agent-tools")
    .description("Build and manage agent tools (REST / code / MCP) — the tool builder");

  // ─── agent-tools list ───────────────────────────────────────────────
  cmd
    .command("list")
    .description("List agent tools for a project")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; json?: boolean }) => {
      try {
        const body = (await listAgentTools({ projectId: opts.project, ...envConfig() })) as {
          data?: { tools?: AgentTool[] };
        };
        const tools = body.data?.tools ?? [];
        if (opts.json) {
          console.log(JSON.stringify(tools, null, 2));
          return;
        }
        if (tools.length === 0) {
          console.log(chalk.dim("  No agent tools yet. Create one with `evalguard agent-tools create`."));
          return;
        }
        console.log(chalk.bold(`\n  Agent tools (${tools.length})\n`));
        for (const t of tools) {
          const secret = t.hasSecret ? chalk.yellow("*") : " ";
          const typed = chalk.dim(`[${t.type}]`.padEnd(7));
          console.log(`  ${secret} ${String(t.name).padEnd(28)} ${typed} ${chalk.dim(t.id ?? "")}`);
        }
        console.log();
      } catch (e) {
        console.error(chalk.red(`agent-tools list failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  // ─── agent-tools create ─────────────────────────────────────────────
  cmd
    .command("create")
    .description("Create an agent tool from a JSON file (--file) or individual flags")
    .requiredOption("--project <id>", "Project UUID")
    .option("--file <path>", "JSON file describing the AgentTool")
    .option("--name <name>", "Tool name (flag mode)")
    .option("--description <text>", "Tool description (flag mode)")
    .option("--type <type>", "rest | code | mcp (flag mode, default rest)")
    .option("--url <url>", "REST endpoint URL (--type rest)")
    .option("--method <method>", "REST method (--type rest, default GET)")
    .option("--source <code>", "Inline source (--type code)")
    .option("--server <server>", "MCP server (--type mcp)")
    .option("--tool-name <name>", "MCP tool name (--type mcp)")
    .option("--parameters <json>", "JSON Schema parameters object (flag mode)")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        project: string;
        file?: string;
        name?: string;
        description?: string;
        type?: string;
        url?: string;
        method?: string;
        source?: string;
        server?: string;
        toolName?: string;
        parameters?: string;
        json?: boolean;
      }) => {
        try {
          let tool: AgentTool;
          if (opts.file) {
            tool = (await readJsonFile(opts.file)) as AgentTool;
          } else {
            tool = buildAgentToolFromFlags(opts);
          }
          const body = (await createAgentTool({
            projectId: opts.project,
            tool,
            ...envConfig(),
          })) as { data?: AgentTool };
          const created = body.data ?? (body as unknown as AgentTool);
          if (opts.json) {
            console.log(JSON.stringify(created, null, 2));
            return;
          }
          console.log(chalk.green(`  ✓ Created agent tool ${chalk.cyan(created.name)}${created.id ? chalk.dim(` (${created.id})`) : ""}`));
          printTool(created);
        } catch (e) {
          console.error(chalk.red(`agent-tools create failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );

  // ─── agent-tools get <id> ───────────────────────────────────────────
  cmd
    .command("get <id>")
    .description("Fetch a single agent tool")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (id: string, opts: { project: string; json?: boolean }) => {
      try {
        const body = (await getAgentTool({ projectId: opts.project, id, ...envConfig() })) as { data?: AgentTool };
        const tool = body.data ?? (body as unknown as AgentTool);
        if (opts.json) {
          console.log(JSON.stringify(tool, null, 2));
          return;
        }
        printTool(tool);
      } catch (e) {
        console.error(chalk.red(`agent-tools get failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  // ─── agent-tools delete <id> ────────────────────────────────────────
  cmd
    .command("delete <id>")
    .description("Delete an agent tool")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (id: string, opts: { project: string; json?: boolean }) => {
      try {
        const body = (await deleteAgentTool({ projectId: opts.project, id, ...envConfig() })) as {
          data?: { id: string; deleted: boolean };
        };
        if (opts.json) {
          console.log(JSON.stringify(body.data ?? body, null, 2));
          return;
        }
        console.log(chalk.green(`  ✓ Deleted agent tool ${chalk.cyan(id)}`));
      } catch (e) {
        console.error(chalk.red(`agent-tools delete failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  // ─── agent-tools test <id> ──────────────────────────────────────────
  cmd
    .command("test <id>")
    .description("Dry-run an agent tool with sample arguments")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--args <json>", "Sample arguments as inline JSON object, or @path to a JSON file")
    .option("--json", "Output as JSON", false)
    .action(async (id: string, opts: { project: string; args: string; json?: boolean }) => {
      try {
        const toolArgs = await parseToolArgs(opts.args);
        const body = (await testAgentTool({
          projectId: opts.project,
          id,
          toolArgs,
          ...envConfig(),
        })) as { data?: AgentToolTestResult };
        const result = body.data ?? (body as unknown as AgentToolTestResult);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const ok = result.ok ? chalk.green("● OK") : chalk.red("● FAILED");
        console.log();
        console.log(`  ${ok}  ${chalk.dim(`stage=${result.stage}`)}${result.status != null ? chalk.dim(` status=${result.status}`) : ""}`);
        if (result.message) console.log(`  ${result.message}`);
        if (result.issues && result.issues.length > 0) {
          console.log(chalk.bold("  Issues:"));
          for (const issue of result.issues) console.log(`    ${chalk.yellow("•")} ${issue}`);
        }
        if (result.body !== undefined) {
          console.log(chalk.dim("  Body:"));
          console.log(`    ${typeof result.body === "string" ? result.body : JSON.stringify(result.body)}`.slice(0, 600));
        }
        console.log();
        if (!result.ok) process.exit(1);
      } catch (e) {
        console.error(chalk.red(`agent-tools test failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
