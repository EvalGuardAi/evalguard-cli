/**
 * Reject an unknown top-level command BEFORE Commander gets to interpret a help
 * flag as "print the root help and succeed".
 *
 * AUDIT 2026-08-08 (cli-unknown-command-with-help-exits-0). Measured on the
 * built CLI, Node 24:
 *
 *   $ evalguard definitely-not-a-command          → error: unknown command …   EXIT 1
 *   $ evalguard definitely-not-a-command --help   → <root help>                EXIT 0
 *
 * Commander resolves `--help` during option parsing on the ROOT command, prints
 * the root help and exits 0, and never reaches the unknown-subcommand branch. So
 * a typo'd command in a CI script — `evalguard scna --help`, or any pipeline
 * that appends `--help` to probe a step — passes silently and the step is
 * skipped rather than failed.
 *
 * The guard runs on raw argv before `parseAsync`, so it is independent of
 * Commander's option-parsing order and cannot be re-broken by a Commander
 * upgrade changing when help is handled.
 */

/**
 * Root-level options that CONSUME the following token as their value. If one is
 * ever added to `program` without being listed here, the guard would mistake its
 * value for a command name — `knownTopLevelCommands` is derived from the live
 * program, so the test in `__tests__/unknown-command.test.ts` asserts this list
 * still matches the program's value-taking root options.
 */
export const ROOT_VALUE_OPTIONS: readonly string[] = ["--profile"];

/**
 * The first positional token in `argv`, skipping root options and their values.
 * Returns `null` when argv carries no positional at all (`evalguard`,
 * `evalguard --help`, `evalguard -V`).
 */
export function firstPositional(
  argv: readonly string[],
  valueOptions: readonly string[] = ROOT_VALUE_OPTIONS,
): string | null {
  const takesValue = new Set(valueOptions);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") return null;
    if (takesValue.has(token)) {
      i++; // consume this option's value
      continue;
    }
    // `--profile=name` carries its value inline, so nothing to consume.
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance — only used to offer a
 * "did you mean".
 *
 * Plain Levenshtein charges 2 for a TRANSPOSITION, which is the single most
 * common typing error: `scna` → `scan` scores 2 and would fall outside any
 * sensible threshold, so the most useful suggestion is exactly the one that
 * never gets made. Counting a swap as 1 fixes that. Command names are short, so
 * the full matrix is cheaper than being clever.
 */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[a.length][b.length];
}

/** Closest known command to `input`, when one is close enough to be a typo. */
export function suggestCommand(
  input: string,
  known: readonly string[],
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const name of known) {
    const d = distance(input, name);
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  // 1/3 of the typed length, at least 1 — enough for a transposition or a
  // dropped character, not enough to "suggest" an unrelated command.
  const threshold = Math.max(1, Math.floor(input.length / 3));
  return best !== null && bestDistance <= threshold ? best : null;
}

/**
 * `null` when argv names a known command (or names none at all); otherwise the
 * unknown token plus a suggestion.
 *
 * `help` is always accepted — it is Commander's built-in command, not one of the
 * registered ones.
 */
export function checkTopLevelCommand(
  argv: readonly string[],
  knownCommands: readonly string[],
  valueOptions: readonly string[] = ROOT_VALUE_OPTIONS,
): { unknown: string; suggestion: string | null } | null {
  const positional = firstPositional(argv, valueOptions);
  if (positional === null) return null;
  if (positional === "help" || knownCommands.includes(positional)) return null;
  return { unknown: positional, suggestion: suggestCommand(positional, knownCommands) };
}

/**
 * A node in the registered command tree, in the shape `checkCommandPath` needs.
 * Structural rather than a Commander import so the guard stays pure and unit
 * testable without constructing a real `Command`.
 */
export interface CommandNode {
  /** Primary name, e.g. `benchmark` or `run`. */
  name: string;
  /** Registered aliases for this command. */
  aliases: readonly string[];
  /** Child commands. Empty ⇒ this is a leaf and its positionals are ARGUMENTS. */
  subcommands: readonly CommandNode[];
  /** Option flags at THIS level that consume the following argv token as a value. */
  valueOptions: readonly string[];
  /** True when the command declares positional arguments of its own. */
  takesPositionalArgs: boolean;
}

/**
 * Reject an unknown SUBCOMMAND at any depth, not just the first positional.
 *
 * AUDIT 2026-08-09 (cli-unknown-subcommand-with-help-exits-0). `checkTopLevelCommand`
 * only ever inspected the FIRST positional, so the exact defect it was written to
 * close survived one level down. Measured on the built CLI, Node 24:
 *
 *   $ evalguard benchmark bogus-suite            → error: unknown command …   EXIT 1
 *   $ evalguard benchmark bogus-suite --help     → <benchmark help>           EXIT 0
 *   $ evalguard siem tokens bogus --help         → <siem tokens help>         EXIT 0
 *
 * Same mechanism as the top-level bug: Commander resolves `--help` during option
 * parsing on the PARENT command, prints that command's help and exits 0 before it
 * reaches the unknown-subcommand branch. A CI step that probes an unrecognised
 * benchmark name — `evalguard benchmark <name> --help` — therefore passes and is
 * skipped rather than failed.
 *
 * Walking rules, in order:
 *  - `--` ends the scan; everything after it is an operand.
 *  - A value-taking option consumes the NEXT token, so that token is never a
 *    command name. The set is per-level, derived from the live program.
 *  - Any other `-`-prefixed token is a flag and is skipped.
 *  - A positional at a node with NO subcommands is an ARGUMENT (e.g. the `<suite>`
 *    of `benchmark run <suite>`) — the scan stops. Validating those belongs to the
 *    command itself, which already exits non-zero for a bad value.
 *  - A positional at a node that HAS subcommands must name one of them, else it is
 *    the unknown-command error. If such a node ALSO declares positional arguments
 *    the token is ambiguous, so the scan stops rather than risk a false reject.
 */
export function checkCommandPath(
  argv: readonly string[],
  root: CommandNode,
): { unknown: string; path: readonly string[]; suggestion: string | null } | null {
  let node = root;
  const path: string[] = [];
  let takesValue = new Set<string>(root.valueOptions);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") return null;
    if (takesValue.has(token)) {
      i++; // consume this option's value
      continue;
    }
    if (token.startsWith("-")) continue; // a flag, or an inline --opt=value

    // `help` is Commander's built-in and is valid at every level.
    if (token === "help") return null;
    if (node.subcommands.length === 0) return null; // leaf: this is an argument

    const match = node.subcommands.find(
      (c) => c.name === token || c.aliases.includes(token),
    );
    if (match) {
      node = match;
      path.push(token);
      takesValue = new Set<string>(match.valueOptions);
      continue;
    }

    // Unknown at a node that dispatches on subcommands.
    if (node.takesPositionalArgs) return null; // ambiguous — could be an argument
    const known = node.subcommands.map((c) => c.name);
    return { unknown: token, path, suggestion: suggestCommand(token, known) };
  }
  return null;
}
