/**
 * Regression: every `evalguard …` command printed on a marketing docs page must
 * actually exist in the CLI.
 *
 * This is the same premise as readme-quickstart-runnable.test.ts one directory
 * over — "a documented command that does not work is a P0" — widened from the
 * package README to the 89 pages under
 * `apps/web/src/app/(marketing)/docs/**\/page.tsx`, which is where customers
 * actually meet us. The README test pins the *files* a quickstart references;
 * this one pins the *command surface* every page invokes.
 *
 * WHY THIS SHAPE
 *
 *  - Resolved against the REAL command graph, built in-process from the same
 *    `register*` functions `src/index.ts` calls. Not a snapshot, not a list
 *    maintained by hand — a check against a copy of the answer is not a check.
 *    Adding, renaming or removing a command/flag moves this gate the same day.
 *
 *  - NO language filter on the samples. `evalguard …` is executed from YAML
 *    `run:` steps and Dockerfile RUN lines too; filtering to ```bash fences
 *    hid the two `evalguard validate …` calls in the GitHub Actions workflow on
 *    integrations/page.tsx, which a reader runs exactly as written.
 *
 *  - The full subcommand chain is walked. `evalguard siem tokens create` is
 *    three levels deep; stopping at two attributes `create`'s flags to `tokens`
 *    and manufactures false "unknown flag" failures.
 *
 * KNOWN GAP — reference-table `options:` rows are NOT checked.
 * cli/page.tsx renders its reference from a data array whose rows look like
 * `["period <apiKeyId> <cadence>", "Set reset cadence: …"]`, and BOTH P0s found
 * on that page today lived in exactly those rows (one omitted a required
 * positional, one named a `--project` flag the command does not have). A check
 * for them was written and then REMOVED rather than shipped: attributing a row
 * to its enclosing command by nearest-preceding `name:` misfiled `generate`'s
 * option rows under `investigate`, so it reported four defects that are not
 * real. A gate that cries wolf gets disabled, and then it protects nothing.
 * Closing this properly needs the array parsed as data (ts-morph or a JSON
 * export of the table), not by regex — worth doing, deliberately not faked here.
 *
 * The extractor is controlled in both directions (see the final `describe`):
 * planted bad command / bad subcommand / bad flag must each be rejected, and
 * the real neighbouring forms must be accepted. A gate that cannot go red is
 * not a gate, and one that cannot stay green is noise.
 */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as commands from "../index.js";

// apps/cli/src/commands/__tests__ → apps/
const APPS_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const DOCS_DIR = path.join(APPS_DIR, "web", "src", "app", "(marketing)", "docs");

/* ------------------------------------------------------------------ */
/* The real command graph                                              */
/* ------------------------------------------------------------------ */

interface Node {
  subs: Map<string, Node>;
  flags: Set<string>;
  /** Long flags that consume a following value (`--project <id>`). */
  valueFlags: Set<string>;
  /** How many positional arguments Commander marks REQUIRED (`<file>`). */
  requiredArgs: number;
  /** Total positionals accepted; -1 when a variadic swallows the rest. */
  maxArgs: number;
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  // `.option()` on the root mirrors src/index.ts's global flags.
  program.option("--profile <name>", "Use a named profile for this invocation");
  for (const [name, fn] of Object.entries(commands)) {
    if (!name.startsWith("register") || typeof fn !== "function") continue;
    (fn as (p: Command) => void)(program);
  }
  return program;
}

/**
 * `login`, `logout`, `eval` and `scan` are declared INLINE in src/index.ts
 * rather than through a `register*` function, and index.ts cannot be imported
 * here — it calls `program.parseAsync()` at module scope. Spawning the real
 * binary for its `--help` is the other option and costs 13-23 s PER command
 * path, which is not something to put in a unit suite.
 *
 * So they are read out of the same source file, and `INLINE_COMMANDS` below
 * asserts the parse actually found all four: if one is renamed, removed, or
 * converted to a registrar, that assertion fails rather than the command
 * silently dropping out of the checked surface.
 */
const INLINE_EXPECTED = ["login", "logout", "eval", "scan"] as const;

function parseInlineCommands(source: string): Map<string, Node> {
  const found = new Map<string, Node>();
  const cmdRe = /^\s*\.command\("([a-z][a-z0-9:_-]*)"\)/gm;
  let m: RegExpExecArray | null;
  const starts: { name: string; at: number }[] = [];
  while ((m = cmdRe.exec(source)) !== null) starts.push({ name: m[1]!, at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.at;
    // A command's option list ends at its `.action(` (or the next `.command(`).
    const actionAt = source.indexOf(".action(", from);
    const nextAt = i + 1 < starts.length ? starts[i + 1]!.at : source.length;
    const to = Math.min(actionAt === -1 ? nextAt : actionAt, nextAt);
    const block = source.slice(from, to);
    const flags = new Set<string>(["--help"]);
    const valueFlags = new Set<string>();
    for (const om of block.matchAll(/\.option\(\s*"(--[a-z0-9][a-z0-9-]*)([^"]*)"/g)) {
      flags.add(om[1]!);
      // `"--model <model>"` / `"--output [fmt]"` take a value; `"--wait"` does not.
      if (/[<[]/.test(om[2] ?? "")) valueFlags.add(om[1]!);
    }
    // `--no-cache` also accepts the positive form on the parsed result, but the
    // documented spelling is what matters, so only the declared string is kept.
    const args = [...block.matchAll(/\.argument\(\s*"([<[])/g)];
    found.set(starts[i]!.name, {
      subs: new Map(),
      flags,
      valueFlags,
      requiredArgs: args.filter((a) => a[1] === "<").length,
      maxArgs: args.length,
    });
  }
  return found;
}

const INLINE_SOURCE = fs.readFileSync(path.join(APPS_DIR, "cli", "src", "index.ts"), "utf-8");
const INLINE_COMMANDS = parseInlineCommands(INLINE_SOURCE);

function toNode(cmd: Command): Node {
  const flags = new Set<string>();
  const valueFlags = new Set<string>();
  for (const opt of cmd.options) {
    if (!opt.long) continue;
    flags.add(opt.long);
    if (opt.required || opt.optional) valueFlags.add(opt.long);
  }
  // Commander only materialises --help on parse; it is always accepted.
  flags.add("--help");
  const subs = new Map<string, Node>();
  for (const sub of cmd.commands) {
    const node = toNode(sub);
    subs.set(sub.name(), node);
    for (const alias of sub.aliases()) subs.set(alias, node);
  }
  const args = (cmd as unknown as { registeredArguments?: { required: boolean; variadic: boolean }[] })
    .registeredArguments ?? [];
  const requiredArgs = args.filter((a) => a.required).length;
  const maxArgs = args.some((a) => a.variadic) ? -1 : args.length;
  return { subs, flags, valueFlags, requiredArgs, maxArgs };
}

const ROOT: Node = toNode(buildProgram());
for (const [name, node] of INLINE_COMMANDS) {
  // Registrars win if a name ever appears in both places.
  if (!ROOT.subs.has(name)) ROOT.subs.set(name, node);
}

/* ------------------------------------------------------------------ */
/* Sample extraction                                                   */
/* ------------------------------------------------------------------ */

function docsPages(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) docsPages(p, out);
    else if (e.name === "page.tsx") out.push(p);
  }
  return out;
}

/**
 * Every `code={`…`}` / `code: `…`` / `example: `…`` template literal.
 *
 * `example` matters: cli/page.tsx builds its reference from a data array whose
 * commands live in `example:` and `usage:` fields, not in a `<CodeBlock>`. 43
 * invocations on that one page were invisible while this matched `code` alone,
 * and two of them were P0s (`budget period` missing its required `<cadence>`,
 * and a `--project` flag on `shadow-ai policy` that does not exist).
 */
export function codeLiterals(src: string): { line: number; code: string }[] {
  const out: { line: number; code: string }[] = [];
  // Third form: a raw `<pre …>{`…`}</pre>`, with no `code` prop at all.
  // ci-cd/page.tsx renders all 8 of its invocations that way, which is exactly
  // where a P0 hid — three flags silently dropped because a trailing `#`
  // comment followed a `\` continuation, so the backslash escaped the SPACE
  // and the shell read `--sarif` as a command.
  const re = /(?:\b(?:code|example)\s*[:=]\s*\{?\s*`)|(?:>\s*\{\s*`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let body = "";
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "\\") {
        body += src[i]! + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        depth++;
        body += "${";
        i += 2;
        continue;
      }
      if (depth > 0) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        body += ch;
        i++;
        continue;
      }
      if (ch === "`") break;
      body += ch;
      i++;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, code: body });
    re.lastIndex = i;
  }
  return out;
}

/** Join backslash-continued shell lines so a flag on line 2 belongs to line 1. */
function logicalLines(code: string): string[] {
  const out: string[] = [];
  let acc = "";
  for (const raw of code.split("\n")) {
    const t = raw.replace(/\r$/, "");
    if (/\\\s*$/.test(t)) {
      acc += t.replace(/\\\s*$/, " ");
      continue;
    }
    out.push(acc + t);
    acc = "";
  }
  if (acc) out.push(acc);
  return out;
}

export interface Invocation {
  tokens: string[];
  raw: string;
}

/** Every `evalguard …` invocation inside one code sample. */
export function invocations(code: string): Invocation[] {
  const out: Invocation[] = [];
  for (const logical of logicalLines(code)) {
    const line = logical.trim();
    if (!line || line.startsWith("#")) continue;
    // Launchers in use across the docs:
    //   evalguard …                    (globally installed — the bin IS `evalguard`)
    //   npx -y @evalguard/cli …        (every blueprint page)
    //   pnpm dlx / yarn dlx @evalguard/cli …
    // `npx evalguard …` is deliberately NOT in that list: as a REGISTRY name
    // (rather than an already-installed bin) `evalguard` belongs to a third
    // party, so that form is banned by scripts/unclaimed-package-name-gate.mjs
    // (SEC-053). The pattern below still matches it on purpose — a regression
    // must stay visible to this gate rather than parse as nothing.
    // Matching only the bare `evalguard` form made all 26 blueprint pages
    // invisible to this gate — 52 samples that were never checked.
    const m = line.match(
      /(?:^|\|\s*|&&\s*|;\s*)(?:\$\s*)?(?:(?:npx|pnpm dlx|yarn dlx|bunx)\s+(?:-y\s+)?)?(?:@evalguard\/cli|evalguard)\s+(.*)$/,
    );
    if (!m) continue;
    // Quoted payloads (firewall probe text, rationales) are arguments, never
    // commands or flags — blank them before tokenising.
    const rest = m[1]!.replace(/"[^"]*"/g, ' "STR" ').replace(/'[^']*'/g, " 'STR' ");
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length) out.push({ tokens, raw: line });
  }
  return out;
}

/**
 * `usage: "evalguard budget <get|set|period> <apiKeyId> [args] [options]"`.
 *
 * A usage line is GRAMMAR, not a literal invocation: it carries `<required>` /
 * `[optional]` placeholders and `a|b|c` alternation, so the required-argument
 * rule does not apply to it. The command name and every `--flag` it names are
 * still assertable, and that is exactly where the `shadow-ai policy (--project)`
 * defect lived.
 */
export function usageStrings(src: string): { line: number; usage: string }[] {
  const out: { line: number; usage: string }[] = [];
  const re = /\busage\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const usage = m[1]!.replace(/\\"/g, '"');
    if (!/^\s*evalguard\s/.test(usage)) continue;
    out.push({ line: src.slice(0, m.index).split("\n").length, usage });
  }
  return out;
}

export type Defect = { kind: string; detail: string };

/**
 * Resolve one invocation against the real command graph.
 * Returns the defects found (empty array = the command is runnable as written).
 */
export function checkInvocation(
  tokens: string[],
  root: Node = ROOT,
  opts: { checkRequiredArgs?: boolean } = {},
): Defect[] {
  const { checkRequiredArgs = true } = opts;
  const defects: Defect[] = [];
  let i = 0;
  // Global flags may precede the subcommand.
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    i += tokens[i] === "--profile" ? 2 : 1;
  }
  const first = tokens[i];
  // `evalguard = { … }` is an HCL block key on the Terraform page, not a
  // command. A real subcommand is a bare identifier.
  if (!first || !/^[a-z][a-z0-9:_-]*$/.test(first)) return defects;

  let node = root.subs.get(first);
  if (!node) {
    return [{ kind: "UNKNOWN_COMMAND", detail: `\`evalguard ${first}\` is not a registered command` }];
  }
  const chain = [first];

  // Walk the FULL subcommand chain.
  let placeholderSub = false;
  for (;;) {
    if (node.subs.size === 0) break;
    const next = tokens[i + chain.length];
    if (!next || next.startsWith("-")) break;
    const child = node.subs.get(next);
    if (child) {
      node = child;
      chain.push(next);
      continue;
    }
    // A usage line stands a placeholder in for the subcommand:
    // `evalguard list <component> [--json]`. `--json` is real on every child of
    // `list` and on none of `list` itself, so the flag set to check against is
    // the union over the children — otherwise a correct usage line reads as a
    // defect (it did, on cli/page.tsx:150).
    if (next === "ARG") {
      placeholderSub = true;
      chain.push(next);
      const union: Set<string> = new Set(node.flags);
      const unionValue: Set<string> = new Set(node.valueFlags);
      for (const c of node.subs.values()) {
        for (const f of c.flags) union.add(f);
        for (const f of c.valueFlags) unionValue.add(f);
      }
      node = { subs: new Map(), flags: union, valueFlags: unionValue, requiredArgs: 0, maxArgs: -1 };
      continue;
    }
    // A positional argument (path, placeholder, quoted string), not a subcommand.
    if (/[./\\]/.test(next) || /^</.test(next) || /^["']?STR/.test(next)) break;
    if (!/^[a-z][a-z0-9:_-]*$/.test(next)) break;
    defects.push({
      kind: "UNKNOWN_SUBCOMMAND",
      detail: `\`evalguard ${chain.join(" ")} ${next}\` — \`${next}\` is not a subcommand of \`${chain.join(" ")}\` (has: ${[...node.subs.keys()].join(", ")})`,
    });
    return defects;
  }

  void placeholderSub;
  const rest = tokens.slice(i + chain.length);
  let positionals = 0;
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k]!;
    if (t === "--") continue;
    if (t.startsWith("--")) {
      const flag = t.split("=")[0]!;
      if (!node.flags.has(flag)) {
        defects.push({
          kind: "UNKNOWN_FLAG",
          detail: `\`${flag}\` is not an option of \`evalguard ${chain.join(" ")}\``,
        });
        continue;
      }
      // `--project <id>` consumes the next token; `--project=<id>` does not.
      if (node.valueFlags.has(flag) && !t.includes("=")) k++;
      continue;
    }
    if (t.startsWith("-")) continue; // short flag; not documented with values here
    positionals++;
  }

  // A command shown without an argument Commander marks REQUIRED does not run:
  // `evalguard scan` exits 1 with "error: missing required argument 'file'".
  if (checkRequiredArgs && positionals < node.requiredArgs) {
    defects.push({
      kind: "MISSING_REQUIRED_ARG",
      detail: `\`evalguard ${chain.join(" ")}\` requires ${node.requiredArgs} positional argument(s); the sample supplies ${positionals}`,
    });
  }
  return defects;
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

const PAGES = docsPages(DOCS_DIR);

describe("every `evalguard` command in the marketing docs is runnable (docs-cli-samples)", () => {
  it("found the docs tree and a real command graph", () => {
    // Positive control for the machinery: if the pages or the command graph
    // ever fail to load, the sweep below would pass by checking nothing.
    expect(PAGES.length).toBeGreaterThanOrEqual(80);
    expect(ROOT.subs.size).toBeGreaterThanOrEqual(80);
    expect(ROOT.subs.has("firewall")).toBe(true); // from a registrar
    expect(ROOT.subs.has("eval")).toBe(true); // declared inline in index.ts
  });

  it("still finds every command index.ts declares inline", () => {
    // The inline scrape is the one part of the graph not built by executing the
    // real registrars, so it gets its own control. A rename or a move to a
    // registrar must fail HERE, loudly, rather than quietly shrinking the
    // surface this gate covers.
    expect([...INLINE_COMMANDS.keys()].sort()).toEqual([...INLINE_EXPECTED].sort());
    // …and the options really were picked up, not an empty set that would make
    // every flag on `evalguard eval` unverifiable.
    expect([...(INLINE_COMMANDS.get("eval")?.flags ?? [])].sort()).toEqual(
      ["--help", "--local", "--model", "--no-cache", "--output", "--project", "--provider", "--verbose", "--wait"],
    );
  });

  it("extracts a non-trivial number of invocations to check", () => {
    let n = 0;
    for (const p of PAGES) {
      for (const s of codeLiterals(fs.readFileSync(p, "utf-8"))) n += invocations(s.code).length;
    }
    // Measured 56 at the time of writing. A floor, not an equality: pages get
    // added. Dropping under it means the extractor silently stopped matching.
    expect(n).toBeGreaterThanOrEqual(40);
  });

  it("names only commands, subcommands and flags that exist", () => {
    const failures: string[] = [];
    for (const p of PAGES) {
      const rel = path.relative(DOCS_DIR, p).replace(/\\/g, "/");
      for (const sample of codeLiterals(fs.readFileSync(p, "utf-8"))) {
        for (const inv of invocations(sample.code)) {
          for (const d of checkInvocation(inv.tokens)) {
            failures.push(`${rel}:${sample.line}  [${d.kind}] ${d.detail}\n      sample: ${inv.raw}`);
          }
        }
      }
    }
    expect(failures.join("\n")).toBe("");
  });

  it("reference-table `usage:` lines name only real commands and flags", () => {
    const failures: string[] = [];
    for (const p of PAGES) {
      const rel = path.relative(DOCS_DIR, p).replace(/\\/g, "/");
      for (const u of usageStrings(fs.readFileSync(p, "utf-8"))) {
        // Usage grammar: drop the optional-group brackets and keep what is
        // inside (`[--url <baseUrl>]` still names the real flag `--url`), and
        // reduce `<a|b|c>` alternation to its first branch so the chain walks.
        const flat = u.usage
          .replace(/[[\]]/g, " ")
          .replace(/<([^<>]*)>/g, (_all, inner: string) => (inner.includes("|") ? inner.split("|")[0]! : "ARG"))
          .replace(/\s+/g, " ")
          .trim();
        const tokens = flat.split(" ").slice(1); // drop the leading `evalguard`
        for (const d of checkInvocation(tokens, ROOT, { checkRequiredArgs: false })) {
          failures.push(`${rel}:${u.line}  [${d.kind}] ${d.detail}\n      usage: ${u.usage}`);
        }
      }
    }
    expect(failures.join("\n")).toBe("");
  });

});

describe("the docs-sample extractor can actually fail (controls)", () => {
  const check = (line: string): Defect[] => {
    const inv = invocations(line);
    expect(inv, `nothing extracted from: ${line}`).toHaveLength(1);
    return checkInvocation(inv[0]!.tokens);
  };

  it("rejects a command that does not exist", () => {
    const d = check("evalguard evaluate tests/x.yaml");
    expect(d.map((x) => x.kind)).toEqual(["UNKNOWN_COMMAND"]);
  });

  it("rejects a subcommand that does not exist", () => {
    const d = check("evalguard siem tokens frobnicate --project p");
    expect(d.map((x) => x.kind)).toEqual(["UNKNOWN_SUBCOMMAND"]);
  });

  it("rejects a flag that does not exist", () => {
    const d = check("evalguard eval --totally-not-a-flag x.json");
    expect(d.map((x) => x.kind)).toEqual(["UNKNOWN_FLAG"]);
  });

  it("accepts the real forms those three are mutations of", () => {
    // Without these, the three tests above would also pass if the resolver
    // rejected everything.
    expect(check("evalguard eval evals/example.json")).toEqual([]);
    expect(check("evalguard siem tokens create --source splunk")).toEqual([]);
    expect(check('evalguard firewall "ignore all previous instructions"')).toEqual([]);
  });

  it("reads commands out of a YAML `run:` step, not just a bash fence", () => {
    const workflow = [
      "      - name: Validate Configs",
      "        run: |",
      "          evalguard validate evals/regression.json",
      "          evalguard validate scans/security.json",
    ].join("\n");
    expect(invocations(workflow)).toHaveLength(2);
  });

  it("does not mistake the Terraform `evalguard = {` block key for a command", () => {
    const hcl = ["terraform {", "  required_providers {", "    evalguard = {", "      source = \"EvalGuardAi/evalguard\""].join("\n");
    for (const inv of invocations(hcl)) expect(checkInvocation(inv.tokens)).toEqual([]);
  });
});
