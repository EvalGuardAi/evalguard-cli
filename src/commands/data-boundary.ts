/**
 * `evalguard data-boundary` — unified four-boundary data-exposure policy (G11).
 *
 * A single clearance-aware policy ties data classification to all four exposure
 * boundaries (user-can-see / workflow-can-use / model-can-receive /
 * output-can-reveal), composing the four existing engines server-side.
 *
 *   evalguard data-boundary get   --org <id>
 *   evalguard data-boundary set   --org <id> --name <name> [--project <id>] --rules-file rules.json [--disabled]
 *   evalguard data-boundary evaluate --org <id> --boundary <b> [--policy <name>] [--content "..."]
 *        [--classification <l>] [--clearance <l>] [--tool <t>] [--agent-client-id <url>]
 *
 * The API functions take an injectable `fetchImpl` so they're unit-testable
 * offline (mirrors agent-memory.ts). Output unwraps the { success, data } envelope.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectArrayField,
  expectBooleanField,
  expectField,
  expectResult,
} from "../lib/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENDPOINT_LIST = "GET /data-boundary";
const ENDPOINT_SET = "POST /data-boundary";
const ENDPOINT_EVAL = "POST /data-boundary/evaluate";
const BOUNDARIES = ["user-can-see", "workflow-can-use", "model-can-receive", "output-can-reveal"] as const;
type Boundary = (typeof BOUNDARIES)[number];

export interface DataBoundaryApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: DataBoundaryApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? boundedFetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function getDataBoundaryPolicies(
  args: { orgId: string } & DataBoundaryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  const q = new URLSearchParams({ orgId: args.orgId });
  return call(`/data-boundary?${q.toString()}`, { method: "GET" }, args);
}

export async function setDataBoundaryPolicy(
  args: {
    orgId: string;
    name: string;
    projectId?: string;
    boundaryRules?: Record<string, unknown>;
    classificationLevels?: string[];
    enabled?: boolean;
  } & DataBoundaryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!args.name) throw new Error("name is required");
  if (args.projectId && !UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  return call(
    "/data-boundary",
    {
      method: "POST",
      body: JSON.stringify({
        orgId: args.orgId,
        name: args.name,
        projectId: args.projectId ?? null,
        boundaryRules: args.boundaryRules ?? {},
        classificationLevels: args.classificationLevels,
        enabled: args.enabled,
      }),
    },
    args,
  );
}

export async function evaluateDataBoundary(
  args: {
    orgId: string;
    boundary: Boundary;
    policyName?: string;
    content?: string;
    classification?: string;
    clearance?: string;
    tool?: string;
    action?: string;
    agentClientId?: string;
  } & DataBoundaryApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!BOUNDARIES.includes(args.boundary)) throw new Error(`boundary must be one of: ${BOUNDARIES.join(", ")}`);
  return call(
    "/data-boundary/evaluate",
    {
      method: "POST",
      body: JSON.stringify({
        orgId: args.orgId,
        boundary: args.boundary,
        policyName: args.policyName,
        content: args.content,
        classification: args.classification,
        clearance: args.clearance,
        tool: args.tool,
        action: args.action,
        agentClientId: args.agentClientId,
      }),
    },
    args,
  );
}

function envConfig(): DataBoundaryApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

export function registerDataBoundary(program: Command): void {
  const cmd = program
    .command("data-boundary")
    .description("Unified four-boundary data-exposure policy — get/set/evaluate");

  cmd
    .command("get")
    .description("List the org's data-boundary policies")
    .requiredOption("--org <id>", "Organization UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; json?: boolean }) => {
      try {
        const body = await getDataBoundaryPolicies({ orgId: opts.org, ...envConfig() });
        // "No data-boundary policies." is a statement that the org has NO
        // data-exposure controls configured, which a reviewer acts on. It was
        // printed with exit 0 for `{"hello":"world"}`, `{"success":true,"data":null}`,
        // `{"success":true,"data":{}}` and an explicit `success:false` error
        // envelope, because `result.policies?.length` reads a missing list as an
        // empty one. `expectArrayField` separates "the server sent []" from
        // "the server never mentioned policies".
        const result = expectResult(body, ENDPOINT_LIST);
        const policies = expectArrayField(result, "policies", ENDPOINT_LIST) as {
          id: string; name: string; enabled: boolean;
        }[];
        if (opts.json) return void console.log(JSON.stringify(result, null, 2));
        if (policies.length === 0) return void console.log(chalk.dim("  No data-boundary policies."));
        console.log(chalk.bold(`\n  ${policies.length} data-boundary policy(ies)\n`));
        for (const p of policies) {
          const state = p.enabled ? chalk.green("enabled") : chalk.dim("disabled");
          console.log(`  • ${p.name} ${chalk.dim(`(${p.id})`)} — ${state}`);
        }
        console.log();
      } catch (e) {
        console.error(chalk.red(`data-boundary get failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("set")
    .description("Create or update a data-boundary policy (keyed by org+name)")
    .requiredOption("--org <id>", "Organization UUID")
    .requiredOption("--name <name>", "Policy name")
    .option("--project <id>", "Scope to a project UUID")
    .option("--rules-file <path>", "JSON file with boundaryRules { boundary: rule }")
    .option("--disabled", "Create the policy disabled", false)
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; name: string; project?: string; rulesFile?: string; disabled?: boolean; json?: boolean }) => {
      try {
        let boundaryRules: Record<string, unknown> = {};
        if (opts.rulesFile) {
          const fs = await import("node:fs");
          const parsed = JSON.parse(fs.readFileSync(opts.rulesFile, "utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("--rules-file must contain a JSON object of { boundary: rule }");
          }
          boundaryRules = parsed as Record<string, unknown>;
        }
        const body = await setDataBoundaryPolicy({
          orgId: opts.org,
          name: opts.name,
          projectId: opts.project,
          boundaryRules,
          enabled: !opts.disabled,
          ...envConfig(),
        });
        const policy = expectResult(
          expectField(expectResult(body, ENDPOINT_SET), "policy", ENDPOINT_SET),
          ENDPOINT_SET,
          ["id", "name"],
        ) as { id: string; name: string };
        if (opts.json) return void console.log(JSON.stringify(policy, null, 2));
        console.log(chalk.green(`  ✓ Saved data-boundary policy "${policy.name}" (${policy.id})`));
      } catch (e) {
        console.error(chalk.red(`data-boundary set failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("evaluate")
    .description("Evaluate one boundary crossing against a stored policy")
    .requiredOption("--org <id>", "Organization UUID")
    .requiredOption("--boundary <b>", `One of: ${BOUNDARIES.join(", ")}`)
    .option("--policy <name>", "Policy name (omit to use the latest enabled)")
    .option("--content <text>", "The data payload crossing the boundary")
    .option("--classification <level>", "Declared classification (public|internal|confidential|restricted)")
    .option("--clearance <level>", "Subject clearance (public|internal|confidential|restricted)")
    .option("--tool <name>", "Tool name (workflow-can-use authz)")
    .option("--action <verb>", "Action verb (workflow-can-use authz)")
    .option("--agent-client-id <url>", "Verified agent Client-ID (workflow-can-use authz)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: {
      org: string; boundary: string; policy?: string; content?: string;
      classification?: string; clearance?: string; tool?: string; action?: string;
      agentClientId?: string; json?: boolean;
    }) => {
      try {
        if (!BOUNDARIES.includes(opts.boundary as Boundary)) {
          throw new Error(`--boundary must be one of: ${BOUNDARIES.join(", ")}`);
        }
        const body = await evaluateDataBoundary({
          orgId: opts.org,
          boundary: opts.boundary as Boundary,
          policyName: opts.policy,
          content: opts.content,
          classification: opts.classification,
          clearance: opts.clearance,
          tool: opts.tool,
          action: opts.action,
          agentClientId: opts.agentClientId,
          ...envConfig(),
        });
        // An ALLOW/DENY on a data-exposure boundary. `decision.allow` being
        // `undefined` renders as DENY, which looks safe and is not — it means
        // the policy was never consulted. Refuse instead.
        const decision = expectResult<{
          allow: boolean; reason: string; redactions?: unknown[]; classification: string;
        }>(
          expectField(expectResult(body, ENDPOINT_EVAL), "decision", ENDPOINT_EVAL),
          ENDPOINT_EVAL,
          ["reason", "classification"],
        );
        const allow = expectBooleanField(decision, "allow", ENDPOINT_EVAL);
        if (opts.json) return void console.log(JSON.stringify(decision, null, 2));
        const verdict = allow ? chalk.green("ALLOW") : chalk.red("DENY");
        console.log(`\n  ${verdict} ${chalk.dim(`[${opts.boundary}]`)} classification=${decision.classification}`);
        console.log(`  ${chalk.dim(decision.reason)}`);
        if (decision.redactions?.length) console.log(chalk.yellow(`  ${decision.redactions.length} span(s) redacted`));
        console.log();
      } catch (e) {
        console.error(chalk.red(`data-boundary evaluate failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
