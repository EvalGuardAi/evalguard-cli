/**
 * `evalguard verify` — Independently verify an exported evidence ledger.
 *
 * This runs the SAME cryptographic verification EvalGuard runs, entirely on the
 * auditor's machine, with no network call and no trust in EvalGuard: it checks
 * the hash chain, sequence contiguity, org isolation, per-record content hash,
 * the Ed25519 signatures under a public key the auditor PINS, and — via a signed
 * checkpoint — that the chain has not been TRUNCATED.
 *
 * Trust anchor: pass --public-key with the key you obtained out-of-band
 * (EvalGuard publishes it at GET /api/v1/compliance/ledger-public-key). Without
 * it, structure is still checked but the result is reported as NOT AUTHENTICATED
 * — a ledger with no pinned key proves nothing about who wrote it.
 *
 * Length anchor: a hash chain proves each record follows the last but proves
 * nothing about how MANY there were — lop the last N records off and what remains
 * is a flawless shorter chain. Only a signed commitment to (seq, head recordHash)
 * makes that visible, so without one this command will NOT certify an export, and
 * an EMPTY export is never certified at all.
 *
 * ⚠ AND THE ANCHOR HAS TO BE ONE *YOU* RETRIEVED. This is the part the first two
 * rounds got wrong. `--checkpoint <file>` requires "a checkpoint the auditor
 * pinned out-of-band" — but the tool never had any way to GO AND GET one, so the
 * only file an auditor could actually put behind that flag was the one the
 * audited operator sent them. A checkpoint is a LOWER bound and the store mints a
 * fresh one on every append, so keeping an old one is ordinary record-keeping,
 * not forgery: truncate a 5-record ledger to 1, hand over the genuine seq-0
 * checkpoint, and this command printed "✓ VERIFIED … proven-to-head" and exited 0
 * with 4 of 5 records deleted and nothing forged.
 *
 * So use --checkpoint-url. It fetches the CURRENT checkpoint from the publisher
 * at verification time and compares it to your export's own head. A fetch that
 * fails — offline, TLS, 401, 404, timeout, garbage — is an explicit CANNOT PROVE
 * COMPLETE and exit 1. It never degrades into "use the one in the file", because
 * an anchor you could not reach is indistinguishable from an anchor someone
 * stopped you reaching, and the party with the motive is the one being audited.
 *
 * ⚠ ROUND 5 — TWO THINGS THIS PARAGRAPH USED TO GET WRONG.
 *
 * (a) `--checkpoint <file>` NO LONGER EXITS 0. Round 4 kept the green "✓ VERIFIED
 * … nothing has been removed from the tail" banner for a file anchor and appended
 * a ⚠ paragraph inside it. That is not honesty, it is a disclaimer on a false
 * sentence: the command still printed "nothing has been removed from the tail"
 * about a chain with 80% of its evidence removed from the tail, and still exited
 * 0, so every script and CI gate reading the exit code still passed. A file anchor
 * now yields its own weaker verdict — `offline-anchor-only`, "NOT CERTIFIED — THE
 * ANCHOR IS A FILE", exit 1 — which states the true, useful thing: the records are
 * authentic and consistent with the anchor you were handed, and their completeness
 * was not established. The flag is KEPT because air-gapped review is real; what is
 * removed is its ability to claim something it never proved.
 *
 * (b) FETCHING WAS NOT ENOUGH EITHER, because the signed body carried no time. A
 * publisher that replayed its own genuine six-year-old seq-0 checkpoint at the URL
 * you fetch made this command print "✓ VERIFIED … Anchor: FETCHED BY THIS COMMAND
 * … (issued 2019-01-01)" and exit 0 on an export missing 4 of 5 records. The
 * printed `issuedAt` was unsigned transport metadata and was compared to nothing.
 * Checkpoints now sign their `issuedAt` AND a one-time challenge this command
 * invents per run; a stale or replayed answer is `checkpoint-stale` /
 * `checkpoint-replayed`, and a publisher too old to sign a timestamp is
 * `checkpoint-freshness-unsigned`. None of them pass.
 *
 * The endpoint is org-scoped and credential-gated: ask the organisation under
 * audit for a read-only, revocable API key (`compliance:read` suffices) and pass
 * it as --checkpoint-token, or set EVALGUARD_CHECKPOINT_TOKEN. That the customer
 * issues the credential does NOT weaken the anchor — they cannot change what the
 * endpoint SAYS (it is signed over the live database head), only whether you can
 * reach it, and a refusal shows up here as a failure you report rather than a
 * pass you mistakenly grant. It is reachable on every plan tier: proving your own
 * evidence is intact is not a paid add-on.
 *
 * Format + algorithm are fully specified so this can be re-implemented in any
 * language: docs/compliance/evidence-verification-spec.md.
 *
 * Usage:
 *   evalguard verify export.json --public-key ledger.pub.pem \
 *       --checkpoint-url https://evalguard.ai --checkpoint-token eg_…
 *   evalguard verify export.json --public-key ledger.pub.pem --checkpoint ckpt.json
 *   evalguard verify export.json --json
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import {
  verifyEvidenceExport,
  verifyEvidenceExportLive,
  type EvidenceExport,
  type EvidenceVerifyResult,
  type LedgerCheckpoint,
  type LedgerRecord,
} from "@evalguard/core/verify";

function readPublicKey(value: string): string {
  // Accept an inline PEM or a path to a .pem file.
  if (value.includes("BEGIN")) return value;
  return fs.readFileSync(value, "utf-8");
}

/**
 * Accept inline checkpoint JSON or a path to a .json file.
 *
 * ⚠ REFUSES AN EVIDENCE EXPORT. `--checkpoint` means "the length commitment I
 * obtained OUT-OF-BAND"; handing it the export itself (which this function used
 * to accept, because it unwraps `.checkpoint` from a wrapper object) reported
 * 100% attacker-controlled data as the strong `pinned-checkpoint` anchor. A file
 * that carries `records` is an export, not an independent commitment.
 */
export function readCheckpoint(value: string): LedgerCheckpoint {
  const raw = value.trimStart().startsWith("{") ? value : fs.readFileSync(value, "utf-8");
  const obj = JSON.parse(raw) as Record<string, unknown>;
  if (Array.isArray(obj.records)) {
    throw new Error(
      "that is an evidence EXPORT, not a checkpoint — --checkpoint takes the signed " +
        "checkpoint you obtained out-of-band from the publisher; passing the export " +
        "back to itself proves nothing",
    );
  }
  // The API's signed-ledger snapshot nests it: { orgId, length, head, checkpoint }.
  const ckpt = (obj.checkpoint ?? obj) as LedgerCheckpoint;
  if (
    typeof ckpt?.orgId !== "string" ||
    typeof ckpt?.seq !== "number" ||
    typeof ckpt?.recordHash !== "string" ||
    typeof ckpt?.keyId !== "string" ||
    typeof ckpt?.signature !== "string"
  ) {
    throw new Error("not a checkpoint ({ orgId, seq, recordHash, keyId, signature })");
  }
  return ckpt;
}

/** Normalise the accepted inputs into an EvidenceExport envelope. */
export function toExport(raw: unknown): EvidenceExport {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const records = (obj.records ?? obj) as LedgerRecord[];
  if (!Array.isArray(records)) {
    throw new Error("input does not contain a `records` array");
  }
  const orgId =
    typeof obj.orgId === "string" ? obj.orgId : (records[0]?.orgId ?? "");
  return {
    format: "evalguard-evidence-export/v1",
    orgId,
    publicKeyPem: typeof obj.publicKeyPem === "string" ? obj.publicKeyPem : undefined,
    // Carry the export's own checkpoint through. Without this the envelope threw
    // the length commitment away before the verifier ever saw it, which is why a
    // truncated export used to print VERIFIED even when it shipped a perfectly
    // good checkpoint that contradicted it.
    checkpoint:
      obj.checkpoint && typeof obj.checkpoint === "object"
        ? (obj.checkpoint as LedgerCheckpoint)
        : undefined,
    records,
  };
}

export interface VerifyVerdict {
  exitCode: 0 | 1;
  lines: string[];
}

/**
 * Render the human-readable verdict + the process exit code from a verification
 * result. Pure, so the exit-code contract is directly testable.
 *
 * ⚠ THE CONTRACT THIS ENFORCES (deep E2E audit 2026-08-02): exit 0 / "✓ VERIFIED"
 * requires ALL THREE of valid, authenticated and complete. It previously required
 * only the first two, so a ledger truncated at the tail — and an entirely EMPTY
 * one — both printed "✓ VERIFIED" and exited 0 with the auditor's real key
 * pinned. `complete` is the checkpoint check; without a checkpoint truncation is
 * mathematically undetectable, so a checkpoint-less export must not be certified.
 *
 * ⚠ ROUND 2 (same audit): `complete` itself was too generous, and a TRUNCATED
 * chain still printed "✓ VERIFIED" with the real key pinned — all the attacker
 * needed was an OLDER GENUINE checkpoint, which the store mints on every append.
 * A checkpoint is a lower bound on length, so it certifies only when the auditor
 * pinned it AND it commits to the export's own head. The other states are now
 * distinct, reason-carrying "CANNOT PROVE COMPLETE" verdicts (exit 1) rather than
 * a green banner: an honest unprovable beats an unearned pass.
 *
 * ⚠ ROUND 5: the green banner is now reachable ONLY via an anchor this command
 * retrieved, whose SIGNED timestamp is inside the freshness window and which
 * echoes this run's one-time challenge. A file anchor gets `offline-anchor-only`
 * and exit 1. Adding a safe mode is not closing the unsafe one, and a banner that
 * needs a warning paragraph inside it to be honest is not honest — so the claim
 * was removed rather than annotated.
 */
export function renderVerdict(
  result: EvidenceVerifyResult,
  ctx: { keyId: string; hasPinnedKey: boolean },
): VerifyVerdict {
  // An empty export is the maximal tamper (every record deleted), not the null
  // one. It is reported first and never softened by any flag.
  if (result.issues.some((i) => i.type === "empty-ledger")) {
    return {
      exitCode: 1,
      lines: [
        chalk.red(
          `✗ NOTHING TO VERIFY — the export contains 0 records.\n` +
            `  An empty ledger proves nothing: it is indistinguishable from one whose\n` +
            `  every record was deleted. This is never a passing result.`,
        ),
      ],
    };
  }

  if (result.valid && result.authenticated && result.complete) {
    const fetched = result.anchorFetch?.ok ? result.anchorFetch : null;
    const c = result.completeness;
    const ageS = c.checkpointAgeMs === null ? null : Math.max(0, Math.round(c.checkpointAgeMs / 1000));
    return {
      exitCode: 0,
      lines: [
        chalk.green(
          `✓ VERIFIED — ${result.length} record(s), org ${result.orgId}, authenticated under key ${ctx.keyId}.\n` +
            `  Complete: a length anchor THIS COMMAND retrieved commits to this export's\n` +
            `  own head (seq ${c.headSeq}), so nothing has been removed from the tail.\n` +
            (fetched ? `  Anchor: fetched from ${fetched.url}\n` : `  Anchor: retrieved by the verifier.\n`) +
            `  Signed ${c.checkpointIssuedAt ?? "?"}${ageS === null ? "" : ` (${ageS}s ago)`} and it echoes this run's\n` +
            `  one-time challenge inside the signature — so it was minted for THIS\n` +
            `  verification and cannot be a replayed recording.`,
        ),
      ],
    };
  }

  // The anchor was supposed to come off the wire and did not. This is NOT a
  // softer form of "no checkpoint": someone may have prevented the fetch, and
  // the party with the motive is the one being audited. Loud, and exit 1.
  if (result.completeness.reason === "checkpoint-unreachable") {
    const why = result.anchorFetch && !result.anchorFetch.ok ? result.anchorFetch.error : "unknown";
    const url = result.anchorFetch?.url ?? "the checkpoint URL";
    return {
      exitCode: 1,
      lines: [
        chalk.yellow(
          `⚠ CANNOT PROVE COMPLETE — the length anchor could not be retrieved.\n` +
            `  ${result.length} record(s), org ${result.orgId}` +
            (result.authenticated ? `, every record verified under key ${ctx.keyId}.` : `. [not authenticated]`) +
            `\n  Tried: ${url}\n` +
            `  Failed: ${why}\n` +
            `  This is NOT a pass and NOT "no checkpoint available". Truncation stays\n` +
            `  invisible without a live anchor, and an anchor you could not reach looks\n` +
            `  exactly like one somebody stopped you reaching. If the endpoint returned\n` +
            `  401/403, ask the organisation for a read-only API key (compliance:read) and\n` +
            `  pass --checkpoint-token. Record the failure in your findings; do not\n` +
            `  substitute the checkpoint that came with the export.`,
        ),
      ],
    };
  }

  // Authentic, but nothing PROVES the length — so truncation cannot be ruled
  // out. Fail closed: a CI gate that goes green here goes green on a ledger with
  // its incriminating tail cut off. The reason matters, so say which one it is
  // rather than emitting one vague warning for several very different states.
  if (result.valid && result.authenticated && !result.complete) {
    const c = result.completeness;
    const ageTxt =
      c.checkpointAgeMs === null ? "unknown age" : `${Math.round(c.checkpointAgeMs / 1000)}s old`;
    const why =
      c.reason === "embedded-checkpoint-only"
        ? `  The only length commitment is the checkpoint EMBEDDED in this export, and\n` +
          `  whoever produced the export chose it. A new checkpoint is signed on EVERY\n` +
          `  append, so keeping an old one is normal record-keeping, not forgery: a chain\n` +
          `  truncated back to seq ${c.checkpointSeq} satisfies a genuine seq-${c.checkpointSeq} checkpoint perfectly.\n` +
          `  A checkpoint is a LOWER bound — it proves nothing unless you know it is the\n` +
          `  latest. Re-run with --checkpoint-url <publisher> so this command fetches the\n` +
          `  CURRENT one itself (--checkpoint-token <read-only key> if it needs one).`
        : c.reason === "checkpoint-behind-head"
          ? `  The checkpoint commits to seq ${c.checkpointSeq}, but this export runs on to seq\n` +
            `  ${c.headSeq}. The ${c.uncommittedTail} record(s) after the commitment are covered by nothing, so a\n` +
            `  truncation anywhere past seq ${c.checkpointSeq} is still invisible — and a stale checkpoint is\n` +
            `  exactly what an attacker who truncated the tail would hand you.\n` +
            `  Re-run with --checkpoint-url <publisher> instead of a saved file: a file is\n` +
            `  only as fresh as the moment somebody saved it.`
          : // ── THE FILE ANCHOR. Deliberately NOT a pass. ──────────────────
            c.reason === "offline-anchor-only"
            ? `  The chain is authentic and it does reach the head your checkpoint FILE\n` +
              `  commits to (seq ${c.headSeq}). That is the strongest thing a file can say, and it\n` +
              `  is not completeness — so this command will not certify it.\n` +
              `  A checkpoint is a LOWER bound and the store mints a fresh one on every\n` +
              `  append, so an older genuine checkpoint is an ordinary artefact that a chain\n` +
              `  truncated back to it satisfies perfectly. A file cannot answer a live\n` +
              `  challenge, and in practice it reached you from the party you are auditing.\n` +
              `  For a real verdict: --checkpoint-url <publisher> (+ --checkpoint-token).\n` +
              `  If this IS an air-gapped review, record exactly this: the records are\n` +
              `  authentic and consistent with the anchor you were given, and their\n` +
              `  completeness was not established.`
            : c.reason === "checkpoint-freshness-unsigned"
              ? `  The anchor was retrieved, but its signature covers no timestamp — this is a\n` +
                `  legacy v1 checkpoint (payload version ${c.checkpointVersion ?? "unknown"}). Its age is not merely\n` +
                `  unknown, it is UNKNOWABLE, and an undateable checkpoint is exactly what a\n` +
                `  replayed six-year-old one looks like. Nothing here distinguishes the two,\n` +
                `  so nothing is certified.\n` +
                `  The publisher is running a build older than checkpoint payload v2. Ask the\n` +
                `  organisation to upgrade; do not accept the checkpoint in the meantime.`
              : c.reason === "checkpoint-stale"
                ? `  The anchor's SIGNED issuedAt is ${c.checkpointIssuedAt ?? "unparseable"} (${ageTxt}), outside the\n` +
                  `  accepted window. A commitment that old proves the head at some past moment,\n` +
                  `  not now — and replaying an old genuine checkpoint is precisely how a\n` +
                  `  truncated chain is made to pass. Re-run; if it keeps happening the\n` +
                  `  responder is serving cached or recorded data, which is itself a finding.`
                : c.reason === "checkpoint-replayed"
                  ? `  The anchor did NOT echo this run's one-time challenge inside its signature.\n` +
                    `  Only the signing key can produce that echo and only after the challenge\n` +
                    `  exists, so this response was not minted for this verification: it is a\n` +
                    `  recording, a cache, or a substituted response. Treat it as a finding —\n` +
                    `  this is positive evidence, not a missing check.`
                  : c.reason === "checkpoint-unchallenged"
                    ? `  The anchor was retrieved but no liveness challenge was issued for it, so\n` +
                      `  its freshness rests entirely on clocks agreeing. Use\n` +
                      `  verifyEvidenceExportLive() / --checkpoint-url, which always challenges.`
                    : `  No signed checkpoint commits to this chain's length, so records removed from\n` +
                      `  the END are undetectable: a truncated chain is still a valid chain.\n` +
                      `  Re-run with --checkpoint-url <publisher> (and --checkpoint-token <read-only\n` +
                      `  key> if the organisation requires one) so the anchor is retrieved live\n` +
                      `  rather than handed to you by the party you are auditing.`;
    const headline =
      c.reason === "offline-anchor-only"
        ? `⚠ NOT CERTIFIED — THE ANCHOR IS A FILE. ${result.length} record(s), org ${result.orgId},`
        : `⚠ AUTHENTIC BUT CANNOT PROVE COMPLETE — ${result.length} record(s), org ${result.orgId},`;
    return {
      exitCode: 1,
      lines: [
        chalk.yellow(
          `${headline}\n` +
            `  every record verified under key ${ctx.keyId}. [${c.reason}]\n` +
            why,
        ),
      ],
    };
  }

  if (result.valid && !ctx.hasPinnedKey) {
    return {
      exitCode: 1,
      lines: [
        chalk.yellow(
          `⚠ STRUCTURE OK (${result.length} records) but NOT AUTHENTICATED.\n` +
            `  Re-run with --public-key <pinned key> to verify authorship — a ledger\n` +
            `  with no pinned key proves nothing about who wrote it.`,
        ),
      ],
    };
  }

  const lines = [
    chalk.red(
      `✗ VERIFICATION FAILED — ${result.issues.length} issue(s); ` +
        (result.firstTamperIndex === null
          ? "see the issues below."
          : `first problem at record index ${result.firstTamperIndex} (${result.verifiedPrefix} clean record(s) before it).`),
    ),
  ];
  for (const issue of result.issues.slice(0, 20)) {
    // index -1 marks a CHAIN-level issue (truncation, checkpoint) — it is not
    // about any one record, so printing "index -1" would be nonsense.
    const where = issue.index < 0 ? "whole chain" : `index ${issue.index} (seq ${issue.seq})`;
    lines.push(chalk.red(`    [${issue.type}] ${where}: ${issue.detail}`));
  }
  if (result.issues.length > 20) {
    lines.push(chalk.red(`    … and ${result.issues.length - 20} more`));
  }
  return { exitCode: 1, lines };
}

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("Independently verify an exported evidence ledger (offline, no trust in EvalGuard)")
    .argument("<file>", "path to an exported ledger JSON ({ records, publicKeyPem?, checkpoint? } or the API's export response)")
    .option(
      "--public-key <keyOrPath>",
      "Ed25519 public key (PEM string or file path) pinned out-of-band — the trust anchor",
    )
    .option(
      "--checkpoint <jsonOrPath>",
      "signed checkpoint from a FILE (air-gapped review). Can FAIL an export but NEVER certifies one — a file " +
        "cannot answer a live challenge and is only as fresh as the moment it was saved. Use --checkpoint-url",
    )
    .option(
      "--checkpoint-url <url>",
      "fetch the CURRENT checkpoint from the publisher (origin or full URL) — the anchor this command retrieves itself",
    )
    .option(
      "--checkpoint-token <token>",
      "read-only API key for --checkpoint-url (or set EVALGUARD_CHECKPOINT_TOKEN)",
    )
    .option("--checkpoint-timeout <ms>", "timeout for --checkpoint-url (default 10000)")
    .option(
      "--allow-insecure-checkpoint-url",
      "permit a plaintext http:// checkpoint URL to a non-loopback host",
      false,
    )
    .option("--json", "emit the machine-readable verdict as JSON", false)
    .action(async (file: string, opts: {
      publicKey?: string;
      checkpoint?: string;
      checkpointUrl?: string;
      checkpointToken?: string;
      checkpointTimeout?: string;
      allowInsecureCheckpointUrl?: boolean;
      json?: boolean;
    }) => {
      let exp: EvidenceExport;
      try {
        exp = toExport(JSON.parse(fs.readFileSync(file, "utf-8")));
      } catch (e) {
        console.error(chalk.red(`Could not read ledger export: ${(e as Error).message}`));
        process.exit(2);
      }

      // Two different anchors is an ambiguity, and an ambiguous anchor is how a
      // stale one wins. Make the auditor choose.
      if (opts.checkpoint && opts.checkpointUrl) {
        console.error(
          chalk.red(
            "--checkpoint and --checkpoint-url are mutually exclusive: pick the anchor you are " +
              "actually relying on. --checkpoint-url is the stronger one.",
          ),
        );
        process.exit(2);
      }

      let trustedCheckpoint: LedgerCheckpoint | undefined;
      if (opts.checkpoint) {
        try {
          trustedCheckpoint = readCheckpoint(opts.checkpoint);
        } catch (e) {
          console.error(chalk.red(`Could not read checkpoint: ${(e as Error).message}`));
          process.exit(2);
        }
      }

      const trustedPublicKeyPem = opts.publicKey ? readPublicKey(opts.publicKey) : undefined;
      const result = opts.checkpointUrl
        ? await verifyEvidenceExportLive(exp, {
            trustedPublicKeyPem,
            checkpointUrl: opts.checkpointUrl,
            // Env var so the credential stays out of shell history and `ps`.
            token: opts.checkpointToken ?? process.env.EVALGUARD_CHECKPOINT_TOKEN,
            timeoutMs: opts.checkpointTimeout ? Number(opts.checkpointTimeout) : undefined,
            allowInsecureUrl: Boolean(opts.allowInsecureCheckpointUrl),
          })
        : verifyEvidenceExport(exp, { trustedPublicKeyPem, trustedCheckpoint });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        // Same three-way gate as the banner — a machine reading --json must not
        // be told 0 for a truncated, empty, or unproven ledger either.
        process.exit(result.valid && result.authenticated && result.complete ? 0 : 1);
      }

      const verdict = renderVerdict(result, {
        keyId: exp.records[0]?.keyId ?? "unknown",
        hasPinnedKey: Boolean(trustedPublicKeyPem),
      });
      for (const line of verdict.lines) console.log(line);
      process.exit(verdict.exitCode);
    });
}
