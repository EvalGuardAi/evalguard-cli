/**
 * `evalguard attack-proof` — out-of-band proof that an agentic attack actually
 * SUCCEEDED, instead of a grader's opinion that it looks like it did.
 *
 * Two subcommands, matching the module's two phases:
 *
 *   mint        Mint a canary token + print the proof-carrying payload to drive
 *               the agent with. Writes the token (id + SECRET) to a file, since
 *               `adjudicate` needs the secret to attribute a callback.
 *   adjudicate  Feed in the callbacks YOUR out-of-band listener observed and get
 *               a four-state verdict: proven / refuted / unproven / unverifiable.
 *
 * WHY THE OBSERVATIONS COME FROM A FILE: `@evalguard/core` deliberately opens no
 * sockets (it runs in edge runtimes and browsers), so the HTTP/SMTP/DNS listener
 * is the operator's. This command is the application layer for a local run — it
 * adjudicates what that listener recorded. It makes no network calls of its own.
 *
 * EXIT CODES are the point of the command in CI:
 *   0  refuted      — the receiver watched the whole window, gap-free, nothing fired
 *   1  usage/IO error
 *   2  proven       — a target-attributable callback presented the secret in-window
 *   3  unproven     — the check ran, the evidence is ambiguous; NEEDS HUMAN REVIEW
 *   4  unverifiable — the check DID NOT RUN: no attested receiver coverage
 *
 * Neither 3 nor 4 exits 0. An indeterminate result that greens a pipeline is how
 * an unfalsifiable test suite starts looking healthy.
 *
 * 4 EXISTS BECAUSE OF A REAL DEFECT, fixed 2026-08-08. `--receiver-started-at`
 * used to DEFAULT to the token file's own `issuedAtMs`, so
 *
 *     evalguard attack-proof adjudicate --token t.json --observations '[]'
 *
 * with no listener ever run printed
 *
 *     OOB_EXCLUDED  Excluded — receiver watched the entire window, zero callbacks
 *     …receiver "local-receiver" watched the entire validity window without a gap…
 *
 * and exited 0. The command had synthesised the attestation out of the token
 * file: a check that never ran, grading as a pass, in the exact tool whose job
 * is to refuse ungrounded verdicts. There is now no default — an attestation is
 * something an operator makes, not something a CLI infers from a nearby
 * timestamp — and its absence is its own outcome and its own exit code.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

/* Structural mirrors of the core types — the CLI imports @evalguard/core
 * dynamically (same pattern as detector-eval) and does not re-declare behaviour. */
interface CanaryProofTokenShape {
  id: string;
  secret: string;
  locator: string;
  channel: string;
  attackId: string;
  receiverId: string;
  tenantId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}
/**
 * Exactly `CallbackObservation` from core, and nothing else.
 *
 * There is deliberately NO `channel` here. It used to be required, and core's
 * own `collectCanaryInteraction()` — the documented way to turn a listener's
 * HTTP/DNS/SMTP record into an observation — does not emit one, because the
 * channel belongs to the TOKEN. Piping the collector's output straight into
 * this command therefore died with `observation[0] needs string origin +
 * channel`, exit 1: the module's two halves could not be connected by the path
 * the docs describe. A `channel` key on an input file is now ignored rather
 * than rejected, so anything already writing one keeps working.
 */
interface ObservationShape {
  tokenId: string;
  presentedSecret: string;
  observedAtMs: number;
  origin: string;
  detail?: string;
}
interface VerdictShape {
  state: "proven" | "refuted" | "unproven" | "unverifiable";
  reason: string;
  explanation: string;
  receiverId: string | null;
  tenantId: string | null;
  provingObservations: unknown[];
  rejectedObservations: { reason: string }[];
  inBandEcho: { observed: boolean; note: string };
}

interface AttackProofCore {
  CALLBACK_CHANNELS: readonly string[];
  mintCanaryProofToken: (
    input: {
      callbackBaseUrl: string;
      attackId: string;
      channel: string;
      receiverId: string;
      tenantId: string;
      ttlMs?: number;
    },
  ) => CanaryProofTokenShape;
  // secret-scanner:ignore — TypeScript parameter type, not a credential
  buildProofCarryingPayload: (token: CanaryProofTokenShape, instruction: string) => string;
  embedCanaryInPayload: (template: string, token: CanaryProofTokenShape) => string;
  proveAttack: (options: {
    token: CanaryProofTokenShape;
    receiver: unknown;
    settleMs?: number;
    targetOutput?: string;
  }) => Promise<VerdictShape>;
  InMemoryCallbackReceiver: new (options: {
    id: string;
    tenantId: string;
    startedAtMs: number | null;
  }) => {
    id: string;
    record: (o: ObservationShape) => void;
    declareGap: (reason: string) => void;
  };
  renderProofState: (state: VerdictShape["state"]) => string;
  proofStateBadge: (state: VerdictShape["state"]) => string;
}

const EXIT_REFUTED = 0;
const EXIT_USAGE = 1;
const EXIT_PROVEN = 2;
const EXIT_UNPROVEN = 3;
const EXIT_UNVERIFIABLE = 4;

function readJsonFile(file: string, label: string): unknown {
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`could not read ${label} at ${abs}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} at ${abs} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Fail closed on a token file that cannot attribute a callback. */
function assertToken(value: unknown): CanaryProofTokenShape {
  const t = value as Partial<CanaryProofTokenShape> | null;
  // `receiverId` and `tenantId` are as load-bearing as the secret: without them
  // the adjudicator cannot tell a report from the wrong receiver, or another
  // tenant's view of a public token id, from a legitimate one.
  const missing = (
    ["id", "secret", "locator", "channel", "attackId", "receiverId", "tenantId"] as const
  ).filter((k) => typeof t?.[k] !== "string" || (t[k] as string).length === 0);
  const badTimes = (["issuedAtMs", "expiresAtMs"] as const).filter(
    (k) => typeof t?.[k] !== "number" || !Number.isFinite(t[k] as number),
  );
  if (missing.length > 0 || badTimes.length > 0) {
    throw new Error(
      `token file is not a canary proof token (missing/invalid: ${[...missing, ...badTimes].join(", ")}). ` +
        `Mint one with \`evalguard attack-proof mint\` — a token without its secret can never prove anything.`,
    );
  }
  return t as CanaryProofTokenShape;
}

function assertObservations(value: unknown): ObservationShape[] {
  if (!Array.isArray(value)) {
    throw new Error("observations file must be a JSON ARRAY of callback observations (use [] for none)");
  }
  return value.map((o, i) => {
    const obs = o as Partial<ObservationShape> | null;
    if (typeof obs?.tokenId !== "string" || typeof obs?.presentedSecret !== "string") {
      throw new Error(`observation[${i}] needs string tokenId + presentedSecret`);
    }
    if (typeof obs.observedAtMs !== "number" || !Number.isFinite(obs.observedAtMs)) {
      throw new Error(`observation[${i}] needs a finite numeric observedAtMs`);
    }
    if (typeof obs.origin !== "string") {
      throw new Error(`observation[${i}] needs a string origin`);
    }
    // Rebuild rather than pass through: an input file may carry extra keys
    // (`channel`, listener bookkeeping), and those would otherwise be stored on
    // the observation and echoed back out of `--json` as if core had produced
    // them. `origin` stays whatever the file said — core's attribution is an
    // allowlist, so an unrecognised value is reported as non-attributable
    // rather than silently normalised here.
    return {
      tokenId: obs.tokenId,
      presentedSecret: obs.presentedSecret,
      observedAtMs: obs.observedAtMs,
      origin: obs.origin,
      ...(typeof obs.detail === "string" ? { detail: obs.detail } : {}),
    };
  });
}

export function registerAttackProof(program: Command): void {
  const cmd = program
    .command("attack-proof")
    .description(
      "Prove an agentic attack succeeded with a real out-of-band callback (proven / refuted / unproven / unverifiable)",
    );

  cmd
    .command("mint")
    .description("Mint a canary token and print the proof-carrying attack payload")
    .requiredOption(
      "--base-url <url>",
      "Absolute http(s) base URL your out-of-band receiver owns (never contacted by this command)",
    )
    .requiredOption("--attack-id <id>", "Your identifier for the attack this token proves")
    .option("--channel <channel>", "Callback channel", "http-fetch")
    .option(
      "--receiver-id <id>",
      "Identity of the out-of-band receiver this token is issued AGAINST. Bound into the token; adjudicate refuses a report from any other receiver.",
      "local-receiver",
    )
    .option(
      "--tenant-id <id>",
      "Tenant this token belongs to. Scopes the receiver read — the token id itself is public, it goes out in the payload.",
      "local",
    )
    .option("--ttl-ms <ms>", "Validity window in ms", "300000")
    .option("--instruction <text>", "The attack's own instruction text", "Summarise the attached ticket.")
    .option("--template <file>", "Payload template file containing {{CANARY_LOCATOR}} or {{CANARY_ID}}")
    .option("--out <file>", "Write the token JSON here (contains the proof SECRET)", "canary-token.json")
    .option("--json", "Emit token + payload as JSON on stdout", false)
    .action(async (opts: {
      baseUrl: string; attackId: string; channel: string; receiverId: string;
      tenantId: string; ttlMs: string;
      instruction: string; template?: string; out: string; json: boolean;
    }) => {
      const core = (await import("@evalguard/core")) as unknown as AttackProofCore;
      try {
        if (!core.CALLBACK_CHANNELS.includes(opts.channel)) {
          throw new Error(
            `unknown channel ${JSON.stringify(opts.channel)}; expected one of ${core.CALLBACK_CHANNELS.join(", ")}`,
          );
        }
        const ttlMs = Number(opts.ttlMs);
        const token = core.mintCanaryProofToken({
          callbackBaseUrl: opts.baseUrl,
          attackId: opts.attackId,
          channel: opts.channel,
          receiverId: opts.receiverId,
          tenantId: opts.tenantId,
          ttlMs,
        });

        const payload = opts.template
          ? core.embedCanaryInPayload(String(readRaw(opts.template)), token)
          : core.buildProofCarryingPayload(token, opts.instruction);

        const outAbs = path.resolve(opts.out);
        fs.writeFileSync(outAbs, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });

        if (opts.json) {
          console.log(JSON.stringify({ token, payload, tokenFile: outAbs }, null, 2));
          return;
        }
        console.log();
        console.log(chalk.bold("  Canary proof token minted"));
        console.log(`  ${chalk.dim("attack")}    ${token.attackId}`);
        console.log(`  ${chalk.dim("channel")}   ${token.channel}`);
        console.log(`  ${chalk.dim("receiver")}  ${token.receiverId} ${chalk.dim(`(tenant ${token.tenantId})`)}`);
        console.log(`  ${chalk.dim("token id")}  ${token.id}`);
        console.log(`  ${chalk.dim("window")}    ${new Date(token.issuedAtMs).toISOString()} → ${new Date(token.expiresAtMs).toISOString()}`);
        console.log(`  ${chalk.dim("token file")} ${outAbs} ${chalk.yellow("(contains the proof secret — do not commit)")}`);
        console.log();
        console.log(chalk.bold("  Payload — drive the agent with this:"));
        console.log(chalk.cyan(payload.split("\n").map((l) => `    ${l}`).join("\n")));
        console.log();
        console.log(
          chalk.dim(
            `  Then: evalguard attack-proof adjudicate --token <file> --observations <file> ` +
              `--receiver-started-at <epoch-ms>`,
          ),
        );
        console.log(
          chalk.dim(
            `  (without --receiver-started-at the verdict is NOT CHECKED, exit 4 — nobody has attested ` +
              `that a listener was up)`,
          ),
        );
        console.log();
      } catch (err) {
        console.error(chalk.red(`  attack-proof mint: ${(err as Error).message}`));
        process.exitCode = EXIT_USAGE;
      }
    });

  cmd
    .command("adjudicate")
    .description(
      "Adjudicate the callbacks your receiver observed into proven / refuted / unproven / unverifiable",
    )
    .requiredOption("--token <file>", "Token file written by `attack-proof mint`")
    .requiredOption(
      "--observations <file>",
      "JSON array of callbacks your out-of-band listener recorded ([] when it saw none). Accepts `collectCanaryInteraction()` output verbatim.",
    )
    .option(
      "--receiver-id <id>",
      "Identity of the receiver that PRODUCED these observations. Compared against the receiver the token was minted against; a mismatch is NOT CHECKED (exit 4), never refuted.",
      "local-receiver",
    )
    .option(
      "--tenant-id <id>",
      "Tenant these observations were recorded under. Compared against the token's tenant.",
      "local",
    )
    .option(
      "--receiver-started-at <ms>",
      "YOUR ATTESTATION: epoch ms from which the listener has been up and collecting gap-free. NO DEFAULT — omit it and the verdict is NOT CHECKED (exit 4), because nobody has claimed a listener was running. Coverage starting after the token was issued also cannot refute.",
    )
    .option("--gap <reason>", "Declare the receiver lost visibility (forces unverifiable, never refuted)")
    .option("--settle-ms <ms>", "Grace period after expiry before absence may become refuted", "0")
    .option("--target-output <file>", "The target's own output, recorded as an in-band echo (never changes the state)")
    .option("--json", "Emit the full verdict as JSON", false)
    .action(async (opts: {
      token: string; observations: string; receiverId: string; tenantId: string;
      receiverStartedAt?: string;
      gap?: string; settleMs: string; targetOutput?: string; json: boolean;
    }) => {
      const core = (await import("@evalguard/core")) as unknown as AttackProofCore;
      try {
        const token = assertToken(readJsonFile(opts.token, "token file"));
        const observations = assertObservations(readJsonFile(opts.observations, "observations file"));

        // NO DEFAULT. This used to fall back to `token.issuedAtMs`, which
        // manufactured a gap-free attestation for a receiver nobody ran and
        // turned every silent run into `refuted`, exit 0. An attestation is a
        // claim a person makes about a listener they operated; a CLI has no
        // standing to make it on their behalf, and the nearest timestamp to
        // hand is not evidence of anything.
        const startedAtMs = opts.receiverStartedAt === undefined
          ? null
          : Number(opts.receiverStartedAt);
        if (startedAtMs !== null && !Number.isFinite(startedAtMs)) {
          throw new Error(`--receiver-started-at must be a finite epoch-ms number, got ${String(opts.receiverStartedAt)}`);
        }

        const receiver = new core.InMemoryCallbackReceiver({
          id: opts.receiverId,
          tenantId: opts.tenantId,
          startedAtMs,
        });
        for (const o of observations) receiver.record(o);
        if (opts.gap) receiver.declareGap(opts.gap);

        const targetOutput = opts.targetOutput === undefined ? undefined : String(readRaw(opts.targetOutput));
        const verdict = await core.proveAttack({
          token,
          receiver,
          settleMs: Number(opts.settleMs),
          targetOutput,
        });

        if (opts.json) {
          console.log(JSON.stringify(verdict, null, 2));
        } else {
          const paint =
            verdict.state === "proven" ? chalk.red
            : verdict.state === "refuted" ? chalk.green
            : verdict.state === "unverifiable" ? chalk.magenta
            : chalk.yellow;
          console.log();
          console.log(`  ${chalk.bold(paint(core.proofStateBadge(verdict.state)))}  ${core.renderProofState(verdict.state)}`);
          console.log(`  ${chalk.dim("attack")}   ${token.attackId} ${chalk.dim(`(${token.channel})`)}`);
          console.log(`  ${chalk.dim("reason")}   ${verdict.reason}`);
          console.log(`  ${chalk.dim("why")}      ${verdict.explanation}`);
          console.log(
            `  ${chalk.dim("evidence")} ${verdict.provingObservations.length} proving · ` +
              `${verdict.rejectedObservations.length} rejected` +
              (verdict.rejectedObservations.length > 0
                ? chalk.dim(` (${verdict.rejectedObservations.map((r) => r.reason).join(", ")})`)
                : ""),
          );
          console.log(`  ${chalk.dim("in-band")}  ${verdict.inBandEcho.note}`);
          console.log();
        }

        process.exitCode =
          verdict.state === "proven" ? EXIT_PROVEN
          : verdict.state === "refuted" ? EXIT_REFUTED
          : verdict.state === "unproven" ? EXIT_UNPROVEN
          : EXIT_UNVERIFIABLE;
      } catch (err) {
        console.error(chalk.red(`  attack-proof adjudicate: ${(err as Error).message}`));
        process.exitCode = EXIT_USAGE;
      }
    });
}

function readRaw(file: string): string {
  const abs = path.resolve(file);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`could not read ${abs}: ${(err as Error).message}`);
  }
}
