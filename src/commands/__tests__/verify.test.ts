import { describe, expect, it } from "vitest";
import { Command } from "commander";
import type { EvidenceVerifyResult } from "@evalguard/core/verify";
import { readCheckpoint, registerVerify, renderVerdict, toExport } from "../verify.js";

const REC = {
  v: 1,
  seq: 0,
  prevHash: "0".repeat(64),
  orgId: "org-1",
  kind: "test",
  argHash: "a".repeat(64),
  timestamp: 1_700_000_000_000,
  metadata: null,
  nonce: null,
  keyId: "key-1",
  recordHash: "b".repeat(64),
  signature: "sig",
};

describe("toExport (input normalisation)", () => {
  it("accepts the canonical envelope { format, orgId, publicKeyPem, records }", () => {
    const exp = toExport({
      format: "evalguard-evidence-export/v1",
      orgId: "org-1",
      publicKeyPem: "PEM",
      records: [REC],
    });
    expect(exp.orgId).toBe("org-1");
    expect(exp.publicKeyPem).toBe("PEM");
    expect(exp.records).toHaveLength(1);
  });

  it("accepts the API export response { records, verification } and derives orgId from records", () => {
    const exp = toExport({ records: [REC], verification: { valid: true } });
    expect(exp.orgId).toBe("org-1"); // from records[0].orgId
    expect(exp.records).toHaveLength(1);
  });

  it("accepts a bare records array", () => {
    const exp = toExport([REC]);
    expect(exp.records).toHaveLength(1);
    expect(exp.orgId).toBe("org-1");
  });

  it("throws a clear error when there is no records array", () => {
    expect(() => toExport({ nope: true })).toThrow(/records/);
  });

  it("carries the export's signed checkpoint through to the verifier", () => {
    // The length commitment was being dropped on the floor here: the envelope
    // was rebuilt with only { format, orgId, publicKeyPem, records }, so a
    // truncated export shipping a perfectly good checkpoint that contradicted it
    // still printed "✓ VERIFIED" — the verifier never saw the checkpoint.
    const checkpoint = {
      orgId: "org-1",
      seq: 4,
      recordHash: "c".repeat(64),
      keyId: "key-1",
      signature: "sig",
    };
    const exp = toExport({ orgId: "org-1", records: [REC], checkpoint });
    expect(exp.checkpoint).toEqual(checkpoint);
  });

  it("leaves checkpoint undefined when the export has none", () => {
    expect(toExport({ orgId: "org-1", records: [REC] }).checkpoint).toBeUndefined();
    expect(toExport([REC]).checkpoint).toBeUndefined();
  });
});

describe("readCheckpoint", () => {
  const CKPT = {
    orgId: "org-1",
    seq: 4,
    recordHash: "c".repeat(64),
    keyId: "key-1",
    signature: "sig",
  };

  it("accepts inline checkpoint JSON", () => {
    expect(readCheckpoint(JSON.stringify(CKPT))).toEqual(CKPT);
  });

  it("unwraps the API's signed-ledger snapshot { orgId, length, head, checkpoint }", () => {
    expect(
      readCheckpoint(JSON.stringify({ orgId: "org-1", length: 5, head: REC, checkpoint: CKPT })),
    ).toEqual(CKPT);
  });

  it("rejects something that is not a checkpoint rather than silently ignoring it", () => {
    // Fail closed: a malformed --checkpoint must never degrade to "no length
    // anchor supplied", which would quietly hand back the old false pass.
    expect(() => readCheckpoint(JSON.stringify({ nope: true }))).toThrow(/checkpoint/);
    expect(() => readCheckpoint(JSON.stringify({ ...CKPT, seq: "4" }))).toThrow(/checkpoint/);
  });

  it("REFUSES the evidence export itself as the pinned checkpoint", () => {
    // ⚠ THE BYPASS THIS PINS: because this function unwraps `.checkpoint` from a
    // wrapper object, `verify export.json --checkpoint export.json` was accepted
    // and then reported as the STRONG `pinned-checkpoint` anchor — 100%
    // attacker-controlled data presented as the out-of-band commitment. A file
    // carrying `records` is an export, not an independent length anchor.
    const exportFile = JSON.stringify({ orgId: "org-1", records: [REC], checkpoint: CKPT });
    expect(() => readCheckpoint(exportFile)).toThrow(/EXPORT, not a checkpoint/);
  });
});

/**
 * EXIT-CODE CONTRACT.
 *
 * ⚠ THE BUG THESE PIN (deep E2E audit 2026-08-02, reproduced against the shipped
 * dist with a real 5-record signed chain and the real key pinned):
 *
 *   TAIL TRUNCATE (5 → 4)     →  "✓ VERIFIED — 4 record(s) …"  EXIT 0
 *   EMPTY  { "records": [] }  →  "✓ VERIFIED — 0 record(s) …"  EXIT 0
 *
 * The banner required only `valid && authenticated`. Neither of those says
 * anything about how many records there were — cut the tail off a signed chain
 * and every surviving record is still perfectly authentic. So the offline tool an
 * auditor runs to prove our evidence is tamper-evident could not tell "all
 * evidence intact" from "all evidence deleted".
 *
 * The command's actual verdict had no test at all before this: the suite covered
 * `toExport` normalisation and command registration only.
 */
describe("renderVerdict (exit-code contract)", () => {
  function verdictOf(over: Partial<EvidenceVerifyResult>): EvidenceVerifyResult {
    return {
      valid: true,
      length: 5,
      firstTamperIndex: null,
      verifiedPrefix: 5,
      issues: [],
      signaturesVerified: true,
      orgId: "org-1",
      authenticated: true,
      trustAnchor: "pinned-key",
      complete: true,
      completeness: {
        proven: true,
        reason: "proven-to-head",
        headSeq: 4,
        checkpointSeq: 4,
        uncommittedTail: 0,
        checkpointVersion: 2,
        checkpointIssuedAt: "2026-08-02T10:00:00.000Z",
        checkpointAgeMs: 12_000,
        challengeEchoed: true,
      },
      // ROUND 5: the certifying baseline is a FETCHED anchor, not a pinned file.
      // `pinned-checkpoint` (a file) can no longer reach exit 0 at all - see the
      // offline-anchor-only case below.
      lengthAnchor: "fetched-checkpoint",
      truncation: { ok: true },
      ...over,
    } as EvidenceVerifyResult;
  }
  const ctx = { keyId: "key-1", hasPinnedKey: true };

  it("EXIT 0 + VERIFIED only when valid AND authenticated AND complete", () => {
    const v = renderVerdict(verdictOf({}), ctx);
    expect(v.exitCode).toBe(0);
    const text = v.lines.join("\n");
    expect(text).toContain("VERIFIED");
    // ⚠ ROUND 5. The banner must not overstate, and the PREVIOUS VERSION OF
    // THIS TEST pinned the overstatement: it asserted the green "✓ VERIFIED …
    // nothing has been removed from the tail" banner for an anchor the auditor
    // supplied as a FILE, with a ⚠ paragraph appended INSIDE the banner. A
    // disclaimer on a false sentence is not honesty, and every caller reading the
    // exit code still saw 0. The green banner is now reachable only for an anchor
    // the command retrieved, and it must say why that is worth anything: a signed
    // mint instant plus a one-time challenge echo.
    expect(text).toContain("retrieved");
    expect(text).toContain("2026-08-02T10:00:00.000Z");
    expect(text).toContain("challenge");
    expect(text).not.toContain("a FILE you supplied");
  });

  it("EXIT 0 + VERIFIED reports the anchor as FETCHED when the command retrieved it", () => {
    const v = renderVerdict(
      verdictOf({
        anchorFetch: {
          ok: true,
          url: "https://evalguard.ai/api/v1/compliance/ledger-checkpoint?orgId=org-1",
          checkpoint: {} as never,
          issuedAt: "2026-08-02T10:00:00.000Z",
          nonce: "a".repeat(32),
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(0);
    const text = v.lines.join("\n");
    // The distinction that is the entire point of round 4: an anchor this
    // command retrieved did not pass through the party being audited.
    expect(text).toContain("fetched from");
    expect(text).toContain("https://evalguard.ai");
    expect(text).not.toContain("a FILE you supplied");
  });

  // ── ROUND 5: A FILE ANCHOR CANNOT CERTIFY ─────────────────────────
  // ⚠ THE SHIPPED BYPASS THIS PINS (reproduced against the round-4 build with
  // the auditor's real key pinned and nothing forged):
  //   verify B-trunc1-old0.json --public-key ledger.pub.pem --checkpoint ckpt-seq0.json
  //   -> "✓ VERIFIED - 1 record(s) ... Complete: the checkpoint commits to this
  //      export's own head (seq 0), so nothing has been removed from the tail."
  //     EXIT 0                                          (4 of 5 records deleted)
  // The seq-0 checkpoint was genuine - one is minted on every append, so keeping
  // an old one is record-keeping, not forgery. Round 4 appended a ⚠ paragraph
  // inside that green banner; the sentence, and the exit code every CI gate
  // reads, were both still wrong.
  it("EXIT 1 + NOT CERTIFIED when the anchor is a FILE, and never claims the tail is intact", () => {
    const v = renderVerdict(
      verdictOf({
        length: 1,
        complete: false,
        lengthAnchor: "pinned-checkpoint",
        truncation: { ok: true },
        completeness: {
          proven: false,
          reason: "offline-anchor-only",
          headSeq: 0,
          checkpointSeq: 0,
          uncommittedTail: 0,
          checkpointVersion: 1,
          checkpointIssuedAt: null,
          checkpointAgeMs: null,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("NOT CERTIFIED");
    expect(text).toContain("offline-anchor-only");
    // The literal false sentence that must never be printed about a file anchor.
    expect(text).not.toContain("nothing has been removed from the tail");
    // ...and it must still say the true, useful thing for air-gapped review.
    expect(text).toContain("authentic");
    expect(text).toContain("--checkpoint-url");
  });

  it("EXIT 1 when the fetched anchor's freshness is UNSIGNED (legacy v1 publisher)", () => {
    const v = renderVerdict(
      verdictOf({
        length: 1,
        complete: false,
        lengthAnchor: "fetched-checkpoint",
        truncation: { ok: true },
        completeness: {
          proven: false,
          reason: "checkpoint-freshness-unsigned",
          headSeq: 0,
          checkpointSeq: 0,
          uncommittedTail: 0,
          checkpointVersion: 1,
          checkpointIssuedAt: null,
          checkpointAgeMs: null,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("checkpoint-freshness-unsigned");
    expect(text).toContain("UNKNOWABLE");
  });

  it("EXIT 1 when the fetched anchor is STALE (a replayed old genuine checkpoint)", () => {
    const v = renderVerdict(
      verdictOf({
        length: 1,
        complete: false,
        lengthAnchor: "fetched-checkpoint",
        truncation: { ok: true },
        completeness: {
          proven: false,
          reason: "checkpoint-stale",
          headSeq: 0,
          checkpointSeq: 0,
          uncommittedTail: 0,
          checkpointVersion: 2,
          checkpointIssuedAt: "2019-01-01T00:00:00.000Z",
          checkpointAgeMs: 220_000_000_000,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("checkpoint-stale");
    expect(text).toContain("2019-01-01T00:00:00.000Z");
  });

  it("EXIT 1 when the fetched anchor does NOT echo this run's challenge", () => {
    const v = renderVerdict(
      verdictOf({
        length: 1,
        complete: false,
        lengthAnchor: "fetched-checkpoint",
        truncation: { ok: true },
        completeness: {
          proven: false,
          reason: "checkpoint-replayed",
          headSeq: 0,
          checkpointSeq: 0,
          uncommittedTail: 0,
          checkpointVersion: 2,
          checkpointIssuedAt: "2026-08-02T10:00:00.000Z",
          checkpointAgeMs: 1_000,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("checkpoint-replayed");
    expect(text).toContain("recording");
  });

  it("EXIT 1 for an authentic chain with NO length commitment (truncation undetectable)", () => {
    const v = renderVerdict(
      verdictOf({
        complete: false,
        lengthAnchor: "none",
        truncation: null,
        completeness: {
          proven: false,
          reason: "no-checkpoint",
          headSeq: 4,
          checkpointSeq: null,
          uncommittedTail: 0,
          checkpointVersion: null,
          checkpointIssuedAt: null,
          checkpointAgeMs: null,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).toContain("CANNOT PROVE COMPLETE");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("--checkpoint");
  });

  it("EXIT 1 for a truncated chain whose only anchor is the EMBEDDED checkpoint", () => {
    // ⚠ THE SHIPPED BYPASS THIS PINS: `verify F-trunc1-old0-ckpt.json
    // --public-key ledger.pub.pem` printed "✓ VERIFIED — 1 record(s) … Complete:
    // no records removed from the tail" and exited 0. The file was a genuine
    // 5-record chain cut to 1, carrying the genuine checkpoint signed when the
    // head really was seq 0 — a normal artefact (one is minted on every append),
    // not a forgery. An export-supplied anchor can never certify.
    const v = renderVerdict(
      verdictOf({
        length: 1,
        complete: false,
        lengthAnchor: "export-checkpoint",
        truncation: { ok: true },
        completeness: {
          proven: false,
          reason: "embedded-checkpoint-only",
          headSeq: 0,
          checkpointSeq: 0,
          uncommittedTail: 0,
          checkpointVersion: 2,
          checkpointIssuedAt: "2026-08-02T10:00:00.000Z",
          checkpointAgeMs: 5_000,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("CANNOT PROVE COMPLETE");
    expect(text).toContain("embedded-checkpoint-only");
    expect(text).toContain("LOWER bound");
    expect(text).toMatch(/signed on EVERY/);
    // ⚠ "Fetch your own from GET …" was NOT actionable advice: the CLI had no
    // way to fetch anything, so the auditor's only route to a checkpoint file
    // was the audited operator — the exact provenance the rule excludes. The
    // remedy has to be a flag that exists. (The old text also promised "no
    // credential required", which is now false as well as useless.)
    expect(text).toContain("--checkpoint-url");
    expect(text).not.toContain("no credential required");
  });

  it("EXIT 1 when the PINNED checkpoint is behind the export's head (stale-pin bypass)", () => {
    // ⚠ ALSO SHIPPED: `--checkpoint ckpt-old2.json` against a chain truncated
    // 5 → 4 printed "✓ VERIFIED — 4 record(s) … checked against a PINNED
    // checkpoint", exit 0. One record HAD been removed; the stale checkpoint
    // only ever proved the chain once reached seq 2.
    const v = renderVerdict(
      verdictOf({
        length: 4,
        complete: false,
        lengthAnchor: "pinned-checkpoint",
        truncation: { ok: true },
        completeness: {
          proven: false,
          reason: "checkpoint-behind-head",
          headSeq: 3,
          checkpointSeq: 2,
          uncommittedTail: 1,
          checkpointVersion: 2,
          checkpointIssuedAt: "2026-08-02T10:00:00.000Z",
          checkpointAgeMs: 5_000,
          challengeEchoed: false,
        },
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("checkpoint-behind-head");
    expect(text).toContain("seq 2");
    // A saved file is exactly how a checkpoint goes stale; the remedy is to
    // fetch, not to fetch-and-save.
    expect(text).toContain("--checkpoint-url");
    expect(text).not.toContain("no credential required");
  });

  it("EXIT 1 for a TRUNCATED chain even though every surviving record is authentic", () => {
    const v = renderVerdict(
      verdictOf({
        valid: false,
        length: 4,
        complete: false,
        signaturesVerified: true,
        truncation: { ok: false, reason: "truncated" },
        issues: [
          { index: -1, seq: -1, type: "truncated", detail: "checkpoint commits to seq 4" },
        ],
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    expect(v.lines.join("\n")).toContain("VERIFICATION FAILED");
    expect(v.lines.join("\n")).not.toContain("✓ VERIFIED");
  });

  it("EXIT 1 + NOTHING TO VERIFY for an EMPTY ledger, whatever else the result says", () => {
    const v = renderVerdict(
      verdictOf({
        valid: false,
        length: 0,
        verifiedPrefix: 0,
        authenticated: false,
        complete: false,
        signaturesVerified: false,
        lengthAnchor: "none",
        truncation: null,
        issues: [{ index: -1, seq: -1, type: "empty-ledger", detail: "zero records" }],
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).toContain("NOTHING TO VERIFY");
    expect(text).not.toContain("✓ VERIFIED");
  });

  it("an empty ledger is refused even if the result claims valid/authenticated/complete", () => {
    // Belt and braces: the empty check is positional (first), so no downstream
    // refactor of the flags can resurrect a green banner over zero records.
    const v = renderVerdict(
      verdictOf({
        length: 0,
        issues: [{ index: -1, seq: -1, type: "empty-ledger", detail: "zero records" }],
      }),
      ctx,
    );
    expect(v.exitCode).toBe(1);
    expect(v.lines.join("\n")).toContain("NOTHING TO VERIFY");
  });

  it("prints a chain-level issue as 'whole chain', not as a bogus record index -1", () => {
    const v = renderVerdict(
      verdictOf({
        valid: false,
        complete: false,
        truncation: { ok: false, reason: "truncated" },
        issues: [{ index: -1, seq: -1, type: "truncated", detail: "1 record(s) removed" }],
      }),
      ctx,
    );
    const text = v.lines.join("\n");
    expect(text).toContain("whole chain");
    expect(text).not.toContain("index -1");
  });

  it("still reports the unauthenticated (no pinned key) case distinctly", () => {
    const v = renderVerdict(
      verdictOf({
        authenticated: false,
        complete: false,
        trustAnchor: "self-asserted",
        lengthAnchor: "none",
        truncation: null,
      }),
      { keyId: "key-1", hasPinnedKey: false },
    );
    expect(v.exitCode).toBe(1);
    expect(v.lines.join("\n")).toContain("NOT AUTHENTICATED");
  });
});

describe("renderVerdict · an unreachable live anchor is loud, and exit 1", () => {
  function unreachableResult(over: Partial<EvidenceVerifyResult> = {}): EvidenceVerifyResult {
    return {
      valid: true,
      length: 1,
      firstTamperIndex: null,
      verifiedPrefix: 1,
      issues: [],
      signaturesVerified: true,
      orgId: "org-1",
      authenticated: true,
      trustAnchor: "pinned-key",
      complete: false,
      completeness: {
        proven: false,
        reason: "checkpoint-unreachable",
        headSeq: 0,
        checkpointSeq: null,
        uncommittedTail: 0,
      },
      lengthAnchor: "fetch-failed",
      truncation: null,
      anchorFetch: {
        ok: false,
        url: "https://evalguard.ai/api/v1/compliance/ledger-checkpoint?orgId=org-1",
        error: "HTTP 401 UNAUTHORIZED",
      },
      ...over,
    } as EvidenceVerifyResult;
  }

  it("EXIT 1, names the URL and the cause, and refuses to fall back to the export's copy", () => {
    // ⚠ THE FAILURE MODE THIS PINS: if a failed fetch quietly reverted to the
    // checkpoint travelling inside the export, an attacker who truncated the
    // ledger would simply firewall the publisher and get their green banner.
    const v = renderVerdict(unreachableResult(), { keyId: "key-1", hasPinnedKey: true });
    expect(v.exitCode).toBe(1);
    const text = v.lines.join("\n");
    expect(text).not.toContain("✓ VERIFIED");
    expect(text).toContain("CANNOT PROVE COMPLETE");
    expect(text).toContain("https://evalguard.ai/api/v1/compliance/ledger-checkpoint");
    expect(text).toContain("HTTP 401 UNAUTHORIZED");
    // Actionable: a 401 means ask the customer for a read-only key.
    expect(text).toContain("--checkpoint-token");
    // And it must never be mistaken for the milder "no checkpoint" state.
    expect(text).toContain("NOT a pass");
  });

  it("says so even when the chain itself is fine — unproven is not proven", () => {
    const v = renderVerdict(
      unreachableResult({ length: 5, verifiedPrefix: 5 }),
      { keyId: "key-1", hasPinnedKey: true },
    );
    expect(v.exitCode).toBe(1);
    expect(v.lines.join("\n")).not.toContain("✓ VERIFIED");
  });
});

describe("registerVerify", () => {
  it("registers the `verify` command with the anchor + fetch options", () => {
    const program = new Command();
    registerVerify(program);
    const cmd = program.commands.find((c) => c.name() === "verify");
    expect(cmd).toBeDefined();
    const optNames = cmd!.options.map((o) => o.long);
    expect(optNames).toContain("--public-key");
    expect(optNames).toContain("--checkpoint");
    expect(optNames).toContain("--json");
    // ⚠ The flags that make the length anchor real. Without a way to FETCH the
    // checkpoint, `--checkpoint <file>` could only ever hold a file the audited
    // operator supplied, and truncation verified.
    expect(optNames).toContain("--checkpoint-url");
    expect(optNames).toContain("--checkpoint-token");
    expect(optNames).toContain("--checkpoint-timeout");
    expect(optNames).toContain("--allow-insecure-checkpoint-url");
    expect(cmd!.description().toLowerCase()).toContain("verify");
  });
});
