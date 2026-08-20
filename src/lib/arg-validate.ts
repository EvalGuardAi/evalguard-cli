/**
 * Argument validation — the caller-error half of the fail-closed boundary.
 *
 * ─── Why this module exists ─────────────────────────────────────────────────
 *
 * `lib/http.ts` closed the RESPONSE side: a body the CLI cannot read is a
 * failure, never an empty result. This closes the REQUEST side, which the
 * 2026-08-09 argument sweep found wide open in 22 places. The shape of every
 * one of them is the same, and it is the shape of the whole audit:
 *
 *     the operator asked for X, the CLI quietly did Y, and printed a
 *     confident artifact describing neither.
 *
 * Measured on the built 3.8.0 CLI before this landed:
 *
 *     $ evalguard runs --project ""
 *         Eval Runs (7)                      ← ANOTHER project's runs. EXIT 0
 *     $ evalguard cost-export <org> --start not-a-date --currency NOTACURRENCY -o cost.csv
 *         ✓ Wrote 4211 bytes to cost.csv     ← month-to-date, in USD.     EXIT 0
 *     $ evalguard moderation image --url … --threshold 5
 *         clean (1.0%)                       ← 0.5 default gate ran.      EXIT 0
 *     $ evalguard logs list --since 2026-08-09 --until 2026-08-01
 *         No logs match this filter.         ← inverted range.            EXIT 0
 *
 * An empty string is not "unspecified". A NaN threshold is not "no threshold".
 * An inverted date range is not "no results". Each is a caller error, and the
 * only honest answer to a caller error is to refuse before doing any work.
 *
 * ─── The convention, stated once ────────────────────────────────────────────
 *
 *   exit 0   the command ran and the answer is good news
 *   exit 1   the command RAN and failed, or a gate it was asked to enforce
 *            tripped (network error, 4xx/5xx, unreadable body, score below
 *            --fail-below, tampered Decision-BOM)
 *   exit 2   the command did NOT run, because an argument was invalid
 *
 * 2 is not invented here: `scorecard --fail-below` already refuses with
 * `parseGateThreshold` → exit 2 + "Refusing to run a CI gate that would
 * silently pass." This module generalises that single correct instance to
 * every other flag, with the same message shape, so a CI script can tell
 * "your invocation is wrong" (2) from "the thing you asked about is bad" (1)
 * without parsing English.
 *
 * ─── Over-strictness is the failure mode to fear here ───────────────────────
 *
 * A validator that rejects everything passes every "rejects bad input" test and
 * is a WORSE defect than the one it replaces, because it breaks working CI. So:
 *
 *   • every bound below is either a real protocol rule (RFC-4122 shape, PURL
 *     grammar, ISO-4217 alpha-3) or the SERVER's own accept rule, copied — never
 *     a number picked because it felt safe;
 *   • the count ceilings are the caps the routes actually apply, so the CLI
 *     refuses exactly the values the server would have silently clamped;
 *   • an unrecognised-but-well-formed currency WARNS rather than refuses, because
 *     ICU's currency list is missing live ISO codes (VED, XAU — verified), and a
 *     hand-maintained registry would rot;
 *   • every validator has a paired positive-control test asserting the VALID
 *     form of the same argument still passes through untouched.
 */
import chalk from "chalk";

/** The command did not run because an argument was invalid. See the header. */
export const EXIT_INVALID_ARGUMENT = 2;

/**
 * Print a refusal and stop, in the shape `parseGateThreshold` established:
 * red "what is wrong", dim "what would otherwise have happened".
 *
 * The consequence clause is not decoration. "Invalid --start" tells an operator
 * their flag is bad; "the export would have covered the current month instead"
 * tells them what almost landed in their FinOps data lake, which is the fact
 * that makes them go and check.
 */
export function refuseArgument(problem: string, consequence: string): never {
  console.error(chalk.red(problem) + chalk.dim(` ${consequence}`));
  process.exit(EXIT_INVALID_ARGUMENT);
  // Unreachable in production; `process.exit` is mocked in tests, and without
  // this the function is not `never` for a caller that mocks it to return.
  throw new Error(problem);
}

/**
 * A flag that was SUPPLIED must carry a value.
 *
 * `--project ""` is the case this exists for. Commander hands the action an
 * empty string, and every `?? default` / `if (value)` downstream reads that as
 * "not supplied" — so the CLI silently substituted the org's default project
 * and printed its runs under the caller's project id. A CI script with an unset
 * `$PROJECT_ID` reported another project's results as its own.
 *
 * Returns the TRIMMED value, or `undefined` when the flag was genuinely absent.
 */
export function requireNonEmptyFlag(
  raw: string | undefined,
  flag: string,
  consequence: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") {
    refuseArgument(
      `Invalid ${flag}: an empty value is not "unspecified" — it is a caller error.`,
      consequence,
    );
  }
  return trimmed;
}

/** Shared numeric front-door: reject anything `Number()` cannot read exactly. */
function readNumber(raw: string | number): number {
  // `Number("")` and `Number("  ")` are 0, not NaN — an empty flag value would
  // otherwise parse as a perfectly valid zero. Same trap parseGateThreshold hit.
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (text === "") return Number.NaN;
  return Number(text);
}

/**
 * A `-n` / `--limit` style row count: a whole number of rows, at least one, no
 * more than the route will actually serve.
 *
 * All five call sites did `opts.limit ? parseInt(opts.limit, 10) : undefined`
 * and then `if (limit) qs.set(...)`, which produces four distinct silent
 * failures from one line:
 *
 *   -n abc          → NaN   → falsy → the flag vanishes, 50 rows come back
 *   -n 0            → 0     → falsy → the flag vanishes, 50 rows come back
 *   -n 2.7          → 2     → parseInt TRUNCATES without a word
 *   -n -5           → -5    → forwarded; the route clamps it back up to 1
 *
 * `max` is the route's own ceiling, so `-n 500` against a route that serves at
 * most 200 is refused rather than answered with 200 rows the operator will read
 * as "that's all there is".
 */
export function parseCountFlag(
  raw: string | undefined,
  flag: string,
  opts: { max: number; consequence: string },
): number | undefined {
  if (raw === undefined) return undefined;
  const n = readNumber(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    refuseArgument(
      `Invalid ${flag}: "${raw}" is not a whole number of rows (1-${opts.max}).`,
      opts.consequence,
    );
  }
  if (n > opts.max) {
    refuseArgument(
      `Invalid ${flag}: ${n} exceeds the ${opts.max} rows this endpoint will return.`,
      `Ask for at most ${opts.max}; ${opts.consequence}`,
    );
  }
  return n;
}

/**
 * `--sample <n>` — a non-negative count, where 0 is meaningful ("sample none").
 * Distinct from {@link parseCountFlag} for exactly that reason.
 */
export function parseNonNegativeIntFlag(
  raw: string | undefined,
  flag: string,
  consequence: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = readNumber(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    refuseArgument(`Invalid ${flag}: "${raw}" is not a non-negative whole number.`, consequence);
  }
  return n;
}

/**
 * A `--threshold` in the unit interval.
 *
 * The three moderation subcommands declared `--threshold <n>` with `parseFloat`
 * as Commander's coercion, which is two bugs in one word:
 *
 *   --threshold abc  → NaN, and `JSON.stringify({threshold: NaN})` emits
 *                      `"threshold":null`, so the field is DROPPED at the wire
 *                      and the server's 0.5 default silently ran instead;
 *   --threshold 5    → 5, forwarded, and a max-category score in 0..1 can never
 *                      reach it, so nothing is ever flagged;
 *   --threshold 0.7x → parseFloat stops at the first bad char and returns 0.7.
 *
 * All three print `clean (1.0%)` and exit 0. The operator believes a stricter
 * gate is in force than the one that actually ran — which is the single worst
 * thing a moderation tool can tell someone.
 */
export function parseUnitIntervalFlag(
  raw: string | undefined,
  flag: string,
  consequence: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = readNumber(raw);
  if (!Number.isFinite(n)) {
    refuseArgument(`Invalid ${flag}: "${raw}" is not a number.`, consequence);
  }
  if (n < 0 || n > 1) {
    refuseArgument(
      `Invalid ${flag}: ${n} is outside the valid range 0-1.`,
      `Scores are fractions in 0..1, so this gate could never fire; ${consequence}`,
    );
  }
  return n;
}

/**
 * An ISO date / instant flag.
 *
 * The server does `new Date(raw)` and falls back to its own default on garbage
 * — for `cost-export` that default is "the current month", so
 * `--start not-a-date` writes a FinOps artifact for a period nobody asked for
 * and exits 0.
 */
export function parseIsoDateFlag(raw: string | undefined, flag: string, consequence: string): Date | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  const ms = Date.parse(text);
  if (text === "" || Number.isNaN(ms)) {
    refuseArgument(
      `Invalid ${flag}: "${raw}" is not an ISO date/time (e.g. 2026-05-01 or 2026-05-01T00:00:00Z).`,
      consequence,
    );
  }
  return new Date(ms);
}

/**
 * A date RANGE must run forwards.
 *
 * The two servers disagree about what an inverted range means, and both are
 * wrong for the operator: `cost/export` SWAPS the bounds and exports a period
 * the caller never named, while the log filter yields nothing and the CLI
 * prints "No logs match this filter." — a clean-looking result produced by a
 * typo. Neither is an answer to the question that was asked.
 */
export function assertChronological(
  start: Date | undefined,
  end: Date | undefined,
  startFlag: string,
  endFlag: string,
  consequence: string,
): void {
  if (!start || !end) return;
  if (start.getTime() > end.getTime()) {
    refuseArgument(
      `Invalid range: ${startFlag} (${start.toISOString()}) is after ${endFlag} (${end.toISOString()}).`,
      consequence,
    );
  }
}

/**
 * An ISO-4217 currency label.
 *
 * The server's guard is `/^[A-Z]{3}$/` and anything failing it becomes
 * `undefined` → the serializers default to USD. So `--currency NOTACURRENCY`
 * produced a FOCUS file whose BillingCurrency column says USD, exit 0, with
 * nothing on screen to say the flag was ignored.
 *
 * The SHAPE check is a hard refusal because it is the server's own accept rule
 * copied verbatim — anything it rejects is guaranteed to be silently dropped.
 * The "is this a real currency" check is only a WARNING: ICU's enumeration is
 * missing live ISO-4217 codes (verified on Node 24: `VED` and `XAU` are both
 * absent), so refusing on it would break correct invocations, and a
 * hand-maintained currency table would be stale within a year.
 */
export function parseCurrencyFlag(
  raw: string | undefined,
  flag: string,
  consequence: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    refuseArgument(
      `Invalid ${flag}: "${raw}" is not a 3-letter ISO-4217 code (e.g. USD, EUR, AED).`,
      consequence,
    );
  }
  if (!isKnownCurrencyCode(code)) {
    console.warn(
      chalk.yellow(`Warning: ${flag} "${code}" is not a currency this runtime recognises.`) +
        chalk.dim(" It will be written to the export verbatim — check it before ingesting."),
    );
  }
  return code;
}

/**
 * True when the runtime's ICU data lists `code`. Returns `true` (i.e. "no
 * opinion") when the enumeration is unavailable — a small-ICU Node build must
 * not turn every currency into a warning.
 */
function isKnownCurrencyCode(code: string): boolean {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.("currency");
    if (!Array.isArray(supported) || supported.length === 0) return true;
    return supported.includes(code);
  } catch {
    return true;
  }
}

/**
 * The loose UUID shape already used by `traces get` / `webhooks test` /
 * `webhooks list` in commands/server-read.ts. Deliberately NOT the strict
 * RFC-4122 v1-8 variant regex used by `cost-export` / `decision-bom`: these ids
 * identify rows the server may have created before the v4 default, and refusing
 * a real id is the over-strict failure this module warns about.
 */
export const LOOSE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A positional `<id>` argument that must be a UUID.
 *
 * `runs get`, `scans get` and every `budget` subcommand took the id on trust
 * while their siblings `traces get`, `webhooks test` and `decision-bom verify`
 * all validated theirs. The id is `encodeURIComponent`-ed before it reaches the
 * URL, so `runs get ../../scorers` was never a traversal — it was a round trip
 * spent to render a 404 that a local check answers instantly, and an id typo'd
 * into a different-but-valid row is indistinguishable from a hit.
 */
export function parseUuidArg(raw: string, label: string, consequence: string): string {
  const id = raw.trim();
  if (!LOOSE_UUID_RE.test(id)) {
    refuseArgument(
      `Invalid ${label}: "${raw}" is not a UUID.`,
      consequence,
    );
  }
  return id;
}

/**
 * A flag that must be an http(s) URL.
 *
 * `moderation image --url "not a url"` was forwarded verbatim; the server has
 * to reject it, so the operator pays a round trip to learn what `new URL()`
 * knows locally. The protocol allow-list matches the flag's own documentation
 * ("Public image URL") — a `file:` or `gopher:` URL is never one.
 */
export function parseHttpUrlFlag(
  raw: string | undefined,
  flag: string,
  consequence: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return refuseArgument(`Invalid ${flag}: "${raw}" is not a URL.`, consequence);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    refuseArgument(
      `Invalid ${flag}: "${raw}" is not an http(s) URL (got "${parsed.protocol}").`,
      consequence,
    );
  }
  return text;
}
