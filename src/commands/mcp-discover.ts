/**
 * `evalguard mcp-discover` — inventory the AI agents and MCP servers installed
 * on THIS machine, risk-score them, and (with `--sessions`) read what those
 * agents ALREADY DID from the transcripts they left on disk.
 *
 * WHY THIS COMMAND EXISTS
 * -----------------------
 * "What AI tools are actually running on my developers' laptops?" is the first
 * question a security team asks about agentic AI, and until now this product
 * could not answer it. `mcp-gateway/shadow-detection` could grade an inventory
 * but not produce one — the observed set was a function argument, so the
 * customer had to already know. Local discovery belongs on the command line —
 * the surface where the person asking the question actually works, and the only
 * one with filesystem access to the machine being inventoried.
 *
 * WHY `--sessions` EXISTS
 * -----------------------
 * A configuration inventory is present-tense and has a present-tense blind
 * spot: an MCP server that was added, used to move data off the box, and then
 * deleted from `mcp.json` leaves NOTHING behind for it to find. The machine
 * reads clean. Coding agents write an append-only record of every session into
 * the user's home directory with no instrumentation and no opt-in, so that
 * record is available retroactively on a laptop nobody onboarded to anything.
 * `--sessions` reads it and reports which tools — including which MCP tools —
 * were actually invoked, and which of those calls look destructive or
 * exfiltrating. Cross-referenced against the config scan it names the servers
 * that were used and then removed.
 *
 * READ-ONLY BY CONSTRUCTION. The adapter below implements three operations:
 * `fileExists`, `readFile`, `listDir`. Every one of them is a read. There is no
 * write path to misuse: a tool that audits a developer's machine must not be
 * able to change it.
 *
 * NEITHER SECRETS NOR TRANSCRIPT CONTENT ARE READ OUT. Core records environment
 * variable NAMES from an MCP block and never their values; the session scanner
 * holds the same line harder, emitting counts, tool names, artefact paths, line
 * numbers and timestamps and never a prompt, a command string, a URL or a tool
 * result. `--json` carries the same guarantee — it is the same object.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  analyzeAgentSessions,
  configuredMcpServerNames,
  discoverMcpServers,
  toObservedServers,
  detectShadowMcpServers,
  transcriptCoveredAgentIds,
  TRANSCRIPT_CATALOG,
  type DiscoveryFileSystem,
  type DiscoveryPlatform,
  type McpDiscoveryResult,
  type SessionForensicsResult,
  type ApprovedMcpServer,
} from "@evalguard/core";

/**
 * The real filesystem, as a read-only capability.
 *
 * `fileExists` deliberately answers false for a directory: every config
 * catalogue entry names a file, and a directory sitting where a config should
 * be is not a config we can parse. The session scanner relies on that same
 * answer to tell a transcript from the directory holding it.
 *
 * `listDir` THROWS rather than returning `[]` for a directory it cannot open.
 * Returning an empty list would turn a permission-denied transcript tree into
 * an empty one, and a machine that blocked the scan would report cleaner than a
 * machine that allowed it — exactly backwards.
 */
export const nodeDiscoveryFs: DiscoveryFileSystem = {
  fileExists(p: string): boolean {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readFile(p: string): string {
    return fs.readFileSync(p, "utf-8");
  },
  listDir(p: string): string[] {
    return fs.readdirSync(p);
  },
};

/** Map Node's `process.platform` onto the catalogue's platform names. */
export function currentPlatform(nodePlatform: string = process.platform): DiscoveryPlatform {
  if (nodePlatform === "win32") return "win32";
  if (nodePlatform === "darwin") return "darwin";
  // Everything else (linux, freebsd, wsl) follows the XDG-style layout.
  return "linux";
}

/** Home directory with separators normalised, which the catalogue expects. */
export function normalizedHome(home: string = os.homedir()): string {
  return home.split(path.sep).join("/");
}

interface DiscoverOptions {
  json?: boolean;
  project?: string[];
  agent?: string[];
  includeDisabled?: boolean;
  approved?: string;
  failOnShadow?: boolean;
  sessions?: boolean;
  sessionsMaxFiles?: string;
}

/**
 * Resolve the root-directory overrides the transcript catalogue names.
 *
 * Core cannot read `process.env` — it is bundled into a server-rendered app
 * where the environment belongs to a different machine — so the CLI, which IS
 * on the machine being audited, resolves them. Only variables the catalogue
 * itself names are consulted; the command does not invent environment
 * variables to read.
 */
export function resolveAgentRootOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const agent of TRANSCRIPT_CATALOG) {
    for (const loc of agent.locations) {
      if (!loc.rootEnvVar) continue;
      const value = env[loc.rootEnvVar];
      if (typeof value === "string" && value.trim().length > 0) {
        out[agent.agentId] = normalizedHome(value.trim());
      }
    }
  }
  return out;
}

/**
 * Load the approved-server allowlist.
 *
 * Absent = an EMPTY allowlist, which means every discovered server is reported
 * as unapproved. That is the correct default for an inventory tool: a customer
 * running this for the first time wants to see everything, and defaulting to
 * "assume approved" would produce a reassuring empty report on a machine nobody
 * has ever reviewed.
 */
function loadApproved(file: string | undefined): ApprovedMcpServer[] {
  if (!file) return [];
  const raw = fs.readFileSync(file, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { servers?: unknown })?.servers;
  if (!Array.isArray(list)) {
    throw new Error(
      `${file} must be a JSON array of {id,url,name} or an object with a "servers" array`,
    );
  }
  return list as ApprovedMcpServer[];
}

function renderHuman(result: McpDiscoveryResult, opts: DiscoverOptions): void {
  console.log();
  console.log(chalk.bold("  AI agent / MCP inventory"));
  console.log(chalk.dim(`  platform ${result.platform} · ${result.pathsChecked} paths probed`));
  console.log();

  if (result.agents.length === 0) {
    console.log(chalk.dim("  No AI agent configuration found on this machine."));
  } else {
    for (const agent of result.agents) {
      const count =
        agent.serverCount === 0
          ? chalk.dim("no MCP servers")
          : chalk.cyan(`${agent.serverCount} MCP server${agent.serverCount === 1 ? "" : "s"}`);
      console.log(`  ${chalk.bold(agent.agentName)} ${chalk.dim(`(${agent.vendor})`)} — ${count}`);
      for (const p of agent.configPaths) console.log(chalk.dim(`      ${p}`));
    }
  }

  if (result.servers.length > 0) {
    console.log();
    console.log(chalk.bold("  Servers"));
    for (const s of result.servers) {
      const endpoint = s.url ?? `stdio: ${s.command ?? "?"}`;
      const flags: string[] = [s.scope];
      // An inferred path is stated in the output, not just in the data model:
      // the reader has to know which findings rest on a guessed location.
      if (s.pathConfidence === "inferred") flags.push(chalk.yellow("inferred-path"));
      if (s.envKeys?.length) flags.push(`env: ${s.envKeys.join(",")}`);
      console.log(`    ${chalk.bold(s.name)} ${chalk.dim("→")} ${endpoint}`);
      console.log(chalk.dim(`      ${s.agentName} · ${flags.join(" · ")}`));
    }
  }

  // THE PART THAT MUST NEVER BE OMITTED. An inventory that hides what it could
  // not read prints a clean report for a machine it failed to examine.
  if (result.unreadable.length > 0) {
    console.log();
    console.log(chalk.yellow.bold(`  ${result.unreadable.length} config(s) could NOT be read`));
    console.log(
      chalk.dim("  These are NOT known to be clean — they were not examined."),
    );
    for (const u of result.unreadable) {
      console.log(chalk.yellow(`    ${u.path}`));
      console.log(chalk.dim(`      ${u.reason}`));
    }
  }

  if (!opts.approved) {
    console.log();
    console.log(
      chalk.dim("  No --approved allowlist given, so every server below counts as unapproved."),
    );
  }
}

/** Top N tool names, so the summary stays readable on a busy machine. */
const TOOL_SUMMARY_LIMIT = 15;
/** Top N suspicious calls printed; the count is always exact. */
const SUSPICIOUS_PRINT_LIMIT = 25;

function renderSessions(result: SessionForensicsResult): void {
  console.log();
  console.log(chalk.bold("  Agent session activity (at rest)"));
  console.log(
    chalk.dim(
      `  ${result.artifacts.length} transcript(s) read · ${result.pathsChecked} paths probed · agents covered: ${transcriptCoveredAgentIds().join(", ")}`,
    ),
  );
  console.log(
    chalk.dim(
      "  Counts, tool names, artefact paths and timestamps only — no prompts, commands, URLs or tool output.",
    ),
  );

  if (result.truncated) {
    console.log();
    console.log(
      chalk.yellow(
        "  Walk TRUNCATED by --sessions-max-files: this is a partial view of the machine.",
      ),
    );
  }

  if (result.artifacts.length === 0) {
    console.log();
    console.log(chalk.dim("  No readable session transcripts found."));
  } else {
    const sessions = new Set<string>();
    for (const a of result.artifacts) for (const s of a.sessionIds) sessions.add(s);
    const totalCalls = result.artifacts.reduce((n, a) => n + a.toolCallCount, 0);
    const prompts = result.artifacts.reduce((n, a) => n + a.promptCount, 0);
    const first = result.artifacts.map((a) => a.firstTimestamp).filter(Boolean).sort()[0];
    const last = result.artifacts.map((a) => a.lastTimestamp).filter(Boolean).sort().pop();
    console.log();
    console.log(
      `  ${chalk.bold(String(sessions.size))} session(s) · ${chalk.bold(String(totalCalls))} tool call(s) · ${prompts} prompt(s)`,
    );
    if (first && last) console.log(chalk.dim(`  activity from ${first} to ${last}`));
  }

  if (result.toolUsage.length > 0) {
    console.log();
    console.log(chalk.bold("  Tools invoked"));
    for (const t of result.toolUsage.slice(0, TOOL_SUMMARY_LIMIT)) {
      const mcp = t.mcpServer ? chalk.cyan(` [mcp: ${t.mcpServer}]`) : "";
      console.log(`    ${String(t.count).padStart(5)}  ${t.toolName}${mcp}`);
    }
    if (result.toolUsage.length > TOOL_SUMMARY_LIMIT) {
      console.log(chalk.dim(`    … ${result.toolUsage.length - TOOL_SUMMARY_LIMIT} more`));
    }
  }

  if (result.suspicious.length > 0) {
    // `low` is the technique/egress band — "this used $( )", "this fetched a
    // URL". It is real and it is in `--json`, but on a busy machine it outnumbers
    // the actionable band by two orders of magnitude, and a human report that
    // prints it in full teaches its reader to stop reading. Summarised here,
    // never dropped.
    const actionable = result.suspicious.filter((s) => s.severity !== "low");
    const lowCount = result.suspicious.length - actionable.length;
    console.log();
    console.log(
      chalk.bold(`  ${result.suspicious.length} tool call(s) matched a destructive/exfil signal`),
    );
    for (const s of actionable.slice(0, SUSPICIOUS_PRINT_LIMIT)) {
      const colour = s.severity === "critical" || s.severity === "high" ? chalk.red : chalk.yellow;
      console.log(
        `    ${colour(s.severity.toUpperCase())} ${s.toolName} ${chalk.dim(`${s.timestamp ?? "no timestamp"}`)}`,
      );
      // The evidence pointer, not the evidence: the reviewer opens the file
      // themselves, under their own authority.
      console.log(chalk.dim(`      ${s.artifactPath}:${s.line}`));
      for (const f of s.findings) console.log(chalk.dim(`      - [${f.kind}] ${f.message}`));
    }
    if (actionable.length > SUSPICIOUS_PRINT_LIMIT) {
      console.log(chalk.dim(`    … ${actionable.length - SUSPICIOUS_PRINT_LIMIT} more at medium+`));
    }
    if (lowCount > 0) {
      console.log(
        chalk.dim(
          `    + ${lowCount} low-severity technique/egress marker(s) — listed in full under --json`,
        ),
      );
    }
  }

  if (result.shadowMcpCheck === "skipped-no-inventory") {
    console.log();
    console.log(
      chalk.dim("  Removed-server cross-check SKIPPED (no config inventory was supplied)."),
    );
  } else if (result.shadowMcpServers.length > 0) {
    console.log();
    console.log(
      chalk.red.bold(
        `  ${result.shadowMcpServers.length} MCP server(s) were USED but are declared by NO config on this machine`,
      ),
    );
    console.log(
      chalk.dim("  A server added, used, and then removed leaves no trace in a config scan."),
    );
    for (const s of result.shadowMcpServers) {
      console.log(
        `    ${chalk.red(s.server)} — ${s.callCount} call(s), tools: ${s.tools.join(", ") || "unknown"}`,
      );
      console.log(chalk.dim(`      last seen ${s.lastSeen ?? "unknown"}`));
    }
  }

  if (result.unevaluated.length > 0) {
    console.log();
    console.log(
      chalk.yellow.bold(`  ${result.unevaluated.length} tool call(s) could NOT be evaluated`),
    );
    console.log(chalk.dim("  These are NOT known to be safe — their arguments did not decode."));
  }

  // Same rule as the config scan: what we could not examine is never omitted.
  if (result.unreadable.length > 0) {
    console.log();
    console.log(
      chalk.yellow.bold(`  ${result.unreadable.length} transcript path(s) could NOT be examined`),
    );
    for (const u of result.unreadable) {
      console.log(chalk.yellow(`    ${u.path}`));
      console.log(chalk.dim(`      ${u.reason}`));
    }
  }
}

export function registerMcpDiscover(program: Command): void {
  program
    .command("mcp-discover")
    .description(
      "Inventory the AI agents and MCP servers installed on this machine, and risk-score them",
    )
    .option("--json", "Emit machine-readable JSON instead of a report")
    .option(
      "-p, --project <dir...>",
      "Also scan these project roots for workspace-scoped MCP config",
    )
    .option("-a, --agent <id...>", "Restrict to these agent ids (e.g. cursor claude-code)")
    .option("--include-disabled", "Include servers the config marks as disabled")
    .option(
      "--approved <file>",
      "JSON allowlist of approved servers: an array of {id,url,name}",
    )
    .option(
      "--fail-on-shadow",
      "Exit non-zero when any unapproved server, or any unreadable config, is found (for CI)",
    )
    .option(
      "--sessions",
      "Also read the session transcripts agents left on disk, and report which tools were INVOKED",
    )
    .option(
      "--sessions-max-files <n>",
      "Cap how many transcript files --sessions reads (a truncated walk is reported, not hidden)",
    )
    .action((opts: DiscoverOptions) => {
      let approved: ApprovedMcpServer[];
      try {
        approved = loadApproved(opts.approved);
      } catch (err) {
        console.error(
          chalk.red(
            `Could not read --approved: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
        return;
      }

      const result = discoverMcpServers(nodeDiscoveryFs, {
        platform: currentPlatform(),
        homeDir: normalizedHome(),
        projectRoots: opts.project,
        agentIds: opts.agent,
        includeDisabled: opts.includeDisabled,
      });

      const shadow = detectShadowMcpServers(toObservedServers(result), approved);

      // The session scan is OPT-IN. Reading a developer's transcripts is a
      // larger step than reading their config, even emitting nothing from them,
      // and a command that did it silently would deserve to be distrusted.
      let sessions: SessionForensicsResult | undefined;
      if (opts.sessions) {
        const maxFiles = opts.sessionsMaxFiles ? Number(opts.sessionsMaxFiles) : undefined;
        if (maxFiles !== undefined && (!Number.isFinite(maxFiles) || maxFiles < 1)) {
          console.error(chalk.red("--sessions-max-files must be a positive integer"));
          process.exit(1);
          return;
        }
        sessions = analyzeAgentSessions(nodeDiscoveryFs, {
          platform: currentPlatform(),
          homeDir: normalizedHome(),
          agentIds: opts.agent,
          agentRootOverrides: resolveAgentRootOverrides(),
          // The config scan on the line above is what makes the removed-server
          // cross-check possible; without it the session scan reports that the
          // check was skipped rather than reporting that nothing was removed.
          configuredServerNames: configuredMcpServerNames(result),
          ...(maxFiles !== undefined ? { maxFiles } : {}),
        });
      }

      if (opts.json) {
        console.log(
          JSON.stringify({ discovery: result, shadow, ...(sessions ? { sessions } : {}) }, null, 2),
        );
      } else {
        renderHuman(result, opts);
        if (shadow.shadowServers.length > 0) {
          console.log();
          console.log(
            chalk.bold(
              `  ${shadow.shadowServers.length} unapproved server(s) · highest risk ${shadow.highestRisk}`,
            ),
          );
          for (const f of shadow.shadowServers) {
            const colour =
              f.severity === "critical" || f.severity === "high" ? chalk.red : chalk.yellow;
            console.log(`    ${colour(f.severity.toUpperCase())} ${f.serverId} ${chalk.dim(`risk ${f.risk}`)}`);
            for (const r of f.reasons) console.log(chalk.dim(`      - ${r}`));
          }
        }
        if (sessions) renderSessions(sessions);
        console.log();
      }

      // An unreadable config fails the gate too. If it did not, a machine that
      // blocked the scan would pass CI more easily than one that allowed it —
      // exactly backwards. The session scan joins the gate on the same terms:
      // a server that was USED and then removed is the strongest shadow signal
      // this command can produce, and an unexaminable transcript is a coverage
      // gap, not a pass.
      const sessionGate =
        sessions !== undefined &&
        (sessions.shadowMcpServers.length > 0 || sessions.unreadable.length > 0);
      if (
        opts.failOnShadow &&
        (shadow.shadowServers.length > 0 || result.unreadable.length > 0 || sessionGate)
      ) {
        process.exit(1);
      }
    });
}
