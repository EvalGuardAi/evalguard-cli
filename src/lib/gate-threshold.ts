import chalk from "chalk";

/* ─── Severity gates (`--fail-on`) ─────────────────────────────────────────
 *
 * The numeric sibling of `parseGateThreshold`, and it exists for the same
 * reason: a gate flag that fails to parse must stop the run, never quietly stop
 * gating.
 *
 * The specific defect this closes, quoted from where it was first found and
 * fixed (`commands/repo-scan.ts:49-64`):
 *
 *   The obvious `if (v in SEVERITY_RANK)` guard is UNSOUND … `in` walks the
 *   prototype chain, so `constructor`, `__proto__`, `toString`, `valueOf`,
 *   `hasOwnProperty`, … all pass. `SEVERITY_RANK[v]` is then a function or an
 *   object, every `rank >= threshold` comparison coerces to NaN and is false,
 *   `flagged` is 0, and the gate exits 0 on a repo full of criticals.
 *
 * That fix landed on one command. `iac-scan`, `secret-scan` and `scan:local`
 * kept the `in` guard — and two of them compounded it with
 * `RANK[value] ?? RANK.high`, which does NOT fall back, because
 * `RANK["constructor"]` is the Object constructor: truthy and non-nullish. So
 * the threshold itself became a function.
 *
 * Both halves live here now, so the next gate command inherits the fix instead
 * of re-deriving the bug:
 *   • {@link parseSeverityGate} — the ONLY sanctioned way to read a `--fail-on`
 *     flag. Allow-list membership, never `in`.
 *   • {@link severityRank} — a Map lookup, so it is structurally incapable of
 *     returning a prototype member even if a future caller skips the parser.
 *     Defence in depth: the parser is the gate, the rank cannot be poisoned.
 */

export const SEVERITY_LEVELS = ["low", "medium", "high", "critical"] as const;
export type GateSeverity = (typeof SEVERITY_LEVELS)[number];

/** Map, not an object literal: `Map#get` has no prototype chain to walk. */
const SEVERITY_RANKS: ReadonlyMap<string, number> = new Map(
  SEVERITY_LEVELS.map((s, i) => [s, i] as const),
);

/**
 * Rank of a severity, or `null` when the string is not one.
 *
 * `null` — not `undefined`, not a silent default — so a caller that forgets to
 * handle it gets `null >= 2` (false, and lint-visible) rather than a NaN
 * comparison that reads as "nothing exceeded the threshold".
 */
export function severityRank(raw: string): number | null {
  return SEVERITY_RANKS.get(String(raw ?? "").trim().toLowerCase()) ?? null;
}

/**
 * Parse a `--fail-on` value. Returns `null` for anything that is not one of the
 * four severities (or `"none"`, when the command opted into report-only mode).
 *
 * Callers MUST treat `null` as a usage error and exit non-zero. Substituting a
 * default here would be the same failure in a new place: the operator asked for
 * a gate the tool did not run, and nothing said so.
 */
export function parseSeverityGate(
  raw: string,
  opts?: { allowNone?: boolean },
): GateSeverity | "none" | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (opts?.allowNone && v === "none") return "none";
  return SEVERITY_LEVELS.includes(v as GateSeverity) ? (v as GateSeverity) : null;
}

/**
 * Parse a CI-gate threshold flag, failing CLOSED on anything non-numeric.
 *
 * Why this exists (audit L11 / L14 / L15): three gate flags compared against a
 * bare `Number(options.x)`. `Number("7.5%")`, `Number("high")` and
 * `Number("")`-adjacent typos yield NaN, and EVERY comparison with NaN is
 * false — so `score < NaN` / `score > NaN` never fires and the gate silently
 * PASSES. A CI gate that quietly stopped gating is strictly worse than one that
 * refuses to run, and the operator gets no signal either way.
 *
 * This mirrors the already-correct inline validation in `gate.ts` (:291-295)
 * and `compliance-check.ts` (:754) — it is the extraction of that pattern, not
 * a new one. `governance-risk.ts`'s local `num()` is deliberately NOT folded in
 * here: it parses optional INPUT scores and throws so the caller can report a
 * usage error, whereas this parses a gate threshold and exits the process.
 *
 * @param raw   the raw flag value as Commander hands it over
 * @param flag  the user-facing flag name, for the error message
 * @param range optional inclusive bounds the value must fall inside
 */
export function parseGateThreshold(
  raw: string | number,
  flag: string,
  range?: { min: number; max: number },
): number {
  // `Number("")` and `Number("   ")` are 0, not NaN — an empty flag value would
  // otherwise parse as a valid threshold of zero and gate nothing.
  const text = typeof raw === "number" ? String(raw) : String(raw).trim();
  const n = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(n)) {
    console.error(
      chalk.red(`Invalid ${flag}: "${raw}" is not a number.`) +
        chalk.dim(" Refusing to run a CI gate that would silently pass."),
    );
    process.exit(2);
  }
  if (range && (n < range.min || n > range.max)) {
    console.error(
      chalk.red(`Invalid ${flag}: ${n} is outside the valid range ${range.min}–${range.max}.`),
    );
    process.exit(2);
  }
  return n;
}
