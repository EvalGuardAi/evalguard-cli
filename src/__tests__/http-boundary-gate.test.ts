/**
 * GATE: every HTTP egress and every JSON decode in the CLI goes through
 * `src/lib/http.ts`.
 *
 * AUDIT 2026-08-08. `evalguard runs --project p1` exited 0 with "No eval runs
 * found for this project." against a stub answering HTTP 200 + `this is not JSON
 * at all {{{`. The root cause was not one command — it was ONE IDIOM,
 * `await res.json().catch(() => null)`, copy-pasted into 33 places, each of which
 * turned "I could not understand the server" into "the server said nothing".
 * Separately, only 3 of ~49 egress points carried a deadline, and a hung backend
 * took 362 seconds to fail.
 *
 * Fixing that per command is how the class comes back: the next command added
 * copies the nearest neighbour. So this test pins the END STATE — a count of
 * ZERO, not "no worse than before". A ratchet that measures a delta lets the
 * debt sit forever; this one fails the moment a raw `fetch(` or a
 * `.json().catch(` reappears anywhere under `src/`.
 *
 * Adding a genuine exception means adding it to ALLOWLIST below WITH a reason,
 * which is a reviewable diff — unlike silently re-introducing the idiom.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each entry is a file plus WHY it is allowed to hold the pattern. An entry
 * without a reason is not an exception, it is an unreviewed regression.
 */
const ALLOWLIST: Record<string, string> = {
  "lib/http.ts":
    "IS the shared boundary — it is the one place allowed to call the global fetch and to parse a body.",
  "lib/same-host-redirect.ts":
    "IS the other half of that boundary: `timedFetch` delegates its single egress call to this file's hop loop, which owns the `redirect: \"manual\"` fetch and the per-hop host check. It is a byte-identical vendored copy of packages/wrapper-core/src/same-host-redirect.ts, pinned by scripts/same-host-redirect-drift-gate.mjs, so it cannot be edited to add unbounded egress without failing that gate.",
  "commands/view.ts":
    "Its `fetch('/api/runs')` calls live inside an HTML template string served to the USER'S BROWSER by the local `evalguard view` dashboard. They are browser-side JS, not Node egress, and rewriting them would break the page.",
};

/** Lines that are wholly a comment are prose, not behaviour. */
const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

/**
 * A SECOND, narrower allowlist, for the raw-body-read scan only.
 *
 * EMPTIED 2026-08-09, and that is the point of the entry that follows.
 *
 * It used to hold `commands/ai-bom.ts`, `commands/cost-export.ts` and
 * `commands/datasets.ts`, with a correct reason: those three download a FILE —
 * a CycloneDX/SPDX document, a FOCUS billing CSV, a dataset export — and
 * `decodeJsonBody` is the wrong tool for a body that is not this API's JSON
 * envelope.
 *
 * The reason was right and the consequence was not. Exempting them from the
 * ENVELOPE decode exempted them from ALL validation, and what they actually did
 * was `await res.text()` straight into `fs.writeFileSync`. Measured on the
 * built 3.8.0 CLI, `ai-bom export` and `cost-export` each wrote 11 of 14 fault
 * bodies to disk as a successful export and exited 0 — including an nginx 502
 * page, a 0-byte file ("✓ Wrote 0 bytes"), `null`, `"ok"`, and 2 MB of filler —
 * and `ai-bom` then told the user to run `cyclonedx validate` on it.
 *
 * The lesson is about the shape of exemptions, not about these three files: an
 * exemption granted for one property must be paired with the check that
 * property still needs, or it silently grants every other property too. So the
 * artifact path now has its own boundary (`readArtifactBody` in lib/http.ts)
 * and this allowlist is EMPTY.
 */
const BODY_READ_ALLOWLIST: Record<string, string> = {};

function scan(pattern: RegExp, extraAllow: Record<string, string> = {}): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    if (rel in ALLOWLIST || rel in extraAllow) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (isCommentLine(text)) return;
      if (pattern.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim() });
      pattern.lastIndex = 0;
    });
  }
  return hits;
}

const render = (hits: Hit[]): string =>
  hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n");

describe("HTTP boundary gate", () => {
  it("no module decodes a response body outside lib/http.ts", () => {
    // `res.json().catch(...)` — the exact idiom that produced the fail-open.
    const hits = scan(/\.json\(\)\s*\.catch\(/);
    expect(
      hits.length,
      `Fail-OPEN JSON decode reintroduced. \`res.json().catch(() => null)\` reports an ` +
        `unreadable server response as an EMPTY one, and every caller then prints its ` +
        `"nothing found" empty state and exits 0. Use \`decodeJsonBody(res, "<endpoint>")\` ` +
        `from lib/http.ts instead:\n${render(hits)}`,
    ).toBe(0);
  });

  it("no module calls the global fetch outside lib/http.ts", () => {
    // A bare `fetch(` not preceded by a dot or word char (so `boundedFetch(`,
    // `timedFetch(` and `fetchImpl(` do not match), plus the
    // `?? fetch` fallback used by the injectable-fetch helpers.
    const hits = [
      ...scan(/(?<![.\w])fetch\s*\(/),
      ...scan(/\?\?\s*fetch\b/),
    ];
    expect(
      hits.length,
      `Un-bounded HTTP egress reintroduced. A raw \`fetch\` has no deadline — a hung ` +
        `backend was measured taking 362 seconds to fail. Use \`boundedFetch\` (a drop-in ` +
        `for \`fetch\`) or \`timedFetch\` from lib/http.ts:\n${render(hits)}`,
    ).toBe(0);
  });

  it("no module hand-rolls a body decode outside lib/http.ts", () => {
    // ADDED 2026-08-08, after the per-command runtime matrix.
    //
    // The two scans above are shaped like the idiom they were written against.
    // `commands/sbom-monitor.ts` satisfied BOTH of them — it used `boundedFetch`
    // and never wrote `.json().catch(` — while decoding its own body:
    //
    //     const text = await res.text();
    //     const json = text ? JSON.parse(text) : {};
    //     return (json.data ?? json) as T;
    //
    // `text ? … : {}` is the same fail-open in different clothing: an empty body
    // and a 204 both became `{}`, which the command rendered as "No SBOM monitor
    // configured for this project." with exit 0. It was the worst row in the
    // matrix (6 of 12 cases fail-open) and the gate was blind to all of it,
    // because the gate tested for a SPELLING rather than for the behaviour.
    //
    // So: `res.text()` is the boundary's own primitive. Any other module calling
    // it is about to parse a body itself.
    const hits = scan(/\bres(?:ponse)?\s*\.\s*text\s*\(/, BODY_READ_ALLOWLIST);
    expect(
      hits.length,
      `A module is reading a response body itself. Whatever it does next, it will not be the ` +
        `fail-closed decode — the last module to do this turned an EMPTY body into "nothing ` +
        `configured" and exited 0. Use \`decodeJsonBody(res, "<endpoint>")\` from lib/http.ts:\n${render(hits)}`,
    ).toBe(0);
  });

  it("no module gives a RAW response envelope an empty-ish fallback", () => {
    // The decode is only half the boundary. The measured matrix showed these
    // surviving it and reopening the hole one level in, at the CONSUMER:
    //
    //     body.data?.reports ?? []     → "no abuse reports"          exit 0
    //     body.data?.forgotten ?? 0    → "✓ Forgot 0 memory item(s)" exit 0
    //     body.data.runs ?? []         → header row, then nothing    exit 0
    //
    // `?? []` / `?? null` / `?? 0` turns "this is not the endpoint's answer"
    // into "the answer is empty" — the same defect as `.catch(() => null)`,
    // spelled with nullish coalescing. `expectArray`, `expectArrayField` and
    // `expectField` in lib/http.ts are the replacements.
    //
    // SCOPE, deliberately narrow: this matches the fallback only when it is
    // applied to `body.data…`, i.e. to a RAW response envelope. An earlier,
    // broader version also matched `data.requirementResults ?? []` inside
    // `normalizeRemoteResult(data: RemoteCheckResult)` — a default on an
    // optional field of an ALREADY-VALIDATED, typed argument, which is correct
    // code. A gate that needs five "known false positive" entries teaches
    // people to add a sixth; a narrow gate at zero does not.
    const hits = scan(/\bbody\s*\.\s*data\s*\??\.?\s*\w*\s*\?\?\s*(?:\[\s*\]|null|0|\{\s*\})/);
    expect(
      hits.length,
      `A fail-OPEN envelope read reintroduced. An empty-ish fallback on a raw response ` +
        `envelope reports "the server sent something I do not recognise" as "there is nothing", ` +
        `and the command then prints its empty state and exits 0. Use expectArray / ` +
        `expectArrayField / expectField from lib/http.ts:\n${render(hits)}`,
    ).toBe(0);
  });

  it("no module CASTS a response envelope into a result type", () => {
    // ADDED 2026-08-09, after the 47 x 15 matrix found 48 fail-open cells
    // across 9 commands that the four scans above were all blind to.
    //
    // The 2026-08-08 pass closed "the body is unreadable" and "the consumer
    // defaulted an absent list to []". A THIRD spelling survived, in 13 places:
    //
    //     const result = body.data ?? (body as unknown as T);
    //
    // It satisfies every scan above — no raw fetch, no `.json().catch(`, no
    // `res.text()`, and the fallback is a cast rather than `[]`/`null`/`0`, so
    // the "empty-ish fallback" regex does not match it either. And it is a
    // fail-open in three ways at once: it never calls `unwrapApiEnvelope` (so a
    // 200 carrying `{"success":false,…}` is rendered as a result), `?? (body as
    // T)` makes an unrelated 200 the result, and `{"success":true,"data":{}}` is
    // truthy so every field reads `undefined`.
    //
    // What that produced, measured, exit 0 every time:
    //     moderation image      →  clean (NaN%)
    //     moderation deepfake   →  likely genuine (NaN% synthetic)
    //     voice deepfake        →  likely genuine (NaN% synthetic)
    //     data-boundary get     →  No data-boundary policies.
    //     gateway-config get    →  Strategy: priority / Cache: off / Rate cap: off
    //     agent-tools get       →  an empty tool card
    //
    // `as unknown as T` is an assertion to the COMPILER and a check of nothing
    // at runtime, which is exactly why `tsc --noEmit` was green throughout.
    // `expectResult(body, "<endpoint>", ["field", …])` is the replacement.
    const hits = scan(/\.\s*data\s*\?\?\s*\(?\s*\w+\s+as\s+/);
    expect(
      hits.length,
      `A response envelope is being CAST into a result type. \`x.data ?? (x as unknown as T)\` ` +
        `renders an unrelated 200 — and an explicit \`success:false\` — as a result, and prints ` +
        `\`undefined\` fields as "clean", "NaN%", "not configured" or an empty list. Use ` +
        `\`expectResult(body, "<endpoint>", [required…])\` from lib/http.ts:\n${render(hits)}`,
    ).toBe(0);
  });

  it("the envelope-cast scan matches the code it was written against (control)", () => {
    // Same discipline as the 2026-08-08 controls: pin the regex to the LITERAL
    // defective lines and to their corrected forms, so narrowing it to make the
    // suite green cannot go unnoticed.
    const cast = /\.\s*data\s*\?\?\s*\(?\s*\w+\s+as\s+/;
    // The six shapes measured fail-open, verbatim from the pre-fix source.
    expect(cast.test("const result = body.data ?? (body as unknown as { flagged: boolean; score: number });")).toBe(true);
    expect(cast.test("const r = body.data ?? (body as unknown as { synthetic: boolean; probability: number });")).toBe(true);
    expect(cast.test("const tool = body.data ?? (body as unknown as AgentTool);")).toBe(true);
    expect(cast.test("return (json.data ?? (json as unknown as T)) as T;")).toBe(true);
    expect(cast.test("const data = json.data ?? (json as unknown as DecisionBomVerifyResult);")).toBe(true);
    expect(cast.test("const policy = body.data?.policy ?? (body as unknown as { policy: X }).policy;")).toBe(false); // narrower shape, caught by review not regex
    // The corrected forms must NOT match.
    expect(cast.test('const r = expectResult(body, "POST /moderation/image", ["flagged", "score"]);')).toBe(false);
    expect(cast.test('const s = expectNumberField(result, "score", endpoint);')).toBe(false);
    // A default on an already-validated typed value stays out of scope.
    expect(cast.test("const suites = (data.suites ?? []).join(', ');")).toBe(false);
  });

  it("no artifact command writes an unvalidated body to disk", () => {
    // The `res.text()` scan above is now allowlist-free, which is what stops
    // `ai-bom export` / `cost-export` / `datasets export` re-acquiring a raw
    // body read. This asserts the POSITIVE half: each of the three actually
    // calls the artifact boundary, so the scan cannot be satisfied by simply
    // deleting the download.
    for (const file of ["commands/ai-bom.ts", "commands/cost-export.ts", "commands/datasets.ts"]) {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(
        src,
        `${file} downloads a document to disk and must validate it through ` +
          `readArtifactBody() before writing — an nginx 502 page filed as a CycloneDX SBOM was ` +
          `the measured outcome of not doing so.`,
      ).toMatch(/readArtifactBody\s*\(/);
    }
    expect(
      Object.keys(BODY_READ_ALLOWLIST).length,
      "The raw-body-read exemption was re-granted. An exemption from the ENVELOPE decode is not " +
        "an exemption from validating the bytes; that conflation is what put a 502 page in an SBOM.",
    ).toBe(0);
  });

  it("the allowlist itself stays small and justified", () => {
    // If this grows, the gate is being routed around rather than satisfied.
    expect(Object.keys(ALLOWLIST).length).toBeLessThanOrEqual(3);
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it("the scanner actually finds the pattern it claims to (control)", () => {
    // Guards against the gate passing because the scan is broken — the failure
    // mode where 51 tests pass while the check is blind. lib/http.ts is
    // allowlisted, so scan() must NOT return it, but a direct read must show the
    // idiom is genuinely present in the tree for the pattern to match.
    const boundary = readFileSync(join(SRC, "lib/http.ts"), "utf8");
    expect(boundary).toMatch(/\.json\(\)\s*\.catch\(/); // quoted in its header comment
    expect(/(?<![.\w])fetch\s*\(/.test("const r = await fetch(url);")).toBe(true);
    expect(/(?<![.\w])fetch\s*\(/.test("const r = await boundedFetch(url);")).toBe(false);
    expect(/(?<![.\w])fetch\s*\(/.test("const r = await timedFetch(url);")).toBe(false);
  });

  it("the two 2026-08-08 scans match the exact code they were written against (control)", () => {
    // These two gates were added because the first two passed while
    // `commands/sbom-monitor.ts` was fail-open in 6 of 12 measured cases. So
    // they are pinned to the literal source lines that were defective, and to
    // the corrected forms, which must NOT match. Without this, narrowing a
    // regex to make the suite green would go unnoticed — the failure mode where
    // the gate is blind and every test still passes.
    const bodyRead = /\bres(?:ponse)?\s*\.\s*text\s*\(/;
    expect(bodyRead.test("  const text = await res.text();")).toBe(true);
    expect(bodyRead.test("  const json = text ? JSON.parse(text) : {};")).toBe(false);
    expect(bodyRead.test('  const b = await decodeJsonBody(res, "GET /x");')).toBe(false);

    const emptyFallback = /\bbody\s*\.\s*data\s*\??\.?\s*\w*\s*\?\?\s*(?:\[\s*\]|null|0|\{\s*\})/;
    // The three shapes measured fail-open.
    expect(emptyFallback.test("const reports = body.data?.reports ?? [];")).toBe(true);
    expect(emptyFallback.test("const forgotten = body.data?.forgotten ?? 0;")).toBe(true);
    expect(emptyFallback.test("for (const r of body.data.runs ?? []) {")).toBe(true);
    // The corrected form.
    expect(
      emptyFallback.test('const r = expectArrayField(body.data, "runs", "GET /agent-runs");'),
    ).toBe(false);
    // A default on an already-validated typed argument is NOT this defect, and
    // must stay out of scope or the gate needs an allowlist of correct code.
    expect(emptyFallback.test("const results = data.requirementResults ?? [];")).toBe(false);
    expect(emptyFallback.test("const suites = (data.suites ?? []).join(', ');")).toBe(false);
  });
});
