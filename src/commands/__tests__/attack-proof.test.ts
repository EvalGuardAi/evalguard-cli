/**
 * `evalguard attack-proof` — reachability + exit-code contract.
 *
 * WHY THIS TEST USES THE REAL `@evalguard/core` AND NOT A MOCK:
 * packages/core/src/attack-proof/ shipped on 2026-08-01 with no export line in
 * packages/core/src/index.ts, so NOTHING outside that directory could import it
 * — the module was unreachable from the SDK, apps/web and this CLI. A
 * `vi.mock("@evalguard/core", …)` would have hidden exactly that, the same way
 * the wholesale core mock in apps/web/src/app/api/v1/simulation/__tests__ hid a
 * route calling the wrong core export for weeks.
 *
 * SCOPE, precisely: `@evalguard/core` resolves here to the BUILT package
 * (packages/core/dist), so this file goes red only after a rebuild that drops
 * the export — VERIFIED: commenting the barrel line out and re-running left all
 * 13 green against a stale dist. The fast, source-level guard is
 * packages/core/src/attack-proof/__tests__/barrel-reachability.test.ts (22
 * assertions, all red without the barrel line). What THIS file uniquely proves
 * is the command's own contract: registration on the shipped program and the
 * exit codes CI reads.
 *
 * Exit codes are the CI contract:
 *   0 refuted · 1 usage/IO error · 2 proven · 3 unproven (needs human review)
 *   · 4 unverifiable (the check DID NOT RUN)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { registerAttackProof } from "../attack-proof.js";
import * as commandsBarrel from "../index.js";
import {
  collectCanaryInteraction,
  mintCanaryProofToken,
  CALLBACK_CHANNELS,
  type CanaryProofToken,
} from "@evalguard/core";

const RECEIVER = "test-receiver";
const TENANT = "test-tenant";

let tmpRoot: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function out(): string {
  return (logSpy.mock.calls as unknown[][]).map((c) => c.join(" ")).join("\n");
}

/** A fresh program with only this command on it. */
function program(): Command {
  const p = new Command();
  p.exitOverride();
  registerAttackProof(p);
  return p;
}

async function run(args: string[]): Promise<number> {
  process.exitCode = 0;
  await program().parseAsync(["node", "evalguard", "attack-proof", ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
}

function writeJson(name: string, value: unknown): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

/** A token whose window has already closed, so absence can become `refuted`. */
function closedWindowToken(overrides: Partial<CanaryProofToken> = {}): CanaryProofToken {
  const token = mintCanaryProofToken({
    callbackBaseUrl: "https://oob.example.test",
    attackId: "indirect-injection-42",
    channel: "http-fetch",
    receiverId: RECEIVER,
    tenantId: TENANT,
    ttlMs: 1000,
  });
  return {
    ...token,
    issuedAtMs: token.issuedAtMs - 60_000,
    expiresAtMs: token.expiresAtMs - 60_000,
    ...overrides,
  };
}

/**
 * The operator's coverage attestation, as the flag takes it.
 *
 * Spelled out at every call site on purpose: there is no default any more, and
 * a test that could omit it and still reach `refuted` would be re-pinning the
 * defect this file now guards.
 */
function attesting(token: CanaryProofToken): string[] {
  return ["--receiver-started-at", String(token.issuedAtMs)];
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalguard-attack-proof-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("attack-proof — wiring", () => {
  it("is exported from the commands barrel the CLI entrypoint imports", () => {
    expect(typeof (commandsBarrel as Record<string, unknown>).registerAttackProof).toBe("function");
  });

  it("is registered on the shipped program in src/index.ts", () => {
    // The entrypoint has a shebang and builds its program at module scope, so
    // assert on its source rather than importing (and running) the CLI.
    const entry = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf8");
    expect(entry).toContain("registerAttackProof");
    expect(entry).toContain("registerAttackProof(program);");
  });

  it("registers both phases as subcommands", () => {
    const cmd = program().commands.find((c) => c.name() === "attack-proof");
    expect(cmd).toBeDefined();
    expect(cmd!.commands.map((c) => c.name()).sort()).toEqual(["adjudicate", "mint"]);
  });

  it("core exposes every attack-proof symbol the command destructures", async () => {
    // FAILS BEFORE THE FIX: packages/core/src/index.ts had no
    // `export * from "./attack-proof"`, so all of these were undefined.
    const core = (await import("@evalguard/core")) as unknown as Record<string, unknown>;
    for (const name of [
      "mintCanaryProofToken",
      "buildProofCarryingPayload",
      "embedCanaryInPayload",
      "proveAttack",
      "InMemoryCallbackReceiver",
      "renderProofState",
      "proofStateBadge",
    ]) {
      expect(typeof core[name], `@evalguard/core.${name}`).toBe("function");
    }
    expect(core.CALLBACK_CHANNELS).toEqual(CALLBACK_CHANNELS);
  });
});

describe("attack-proof mint", () => {
  it("writes a usable token and prints a payload carrying its locator", async () => {
    const tokenFile = path.join(tmpRoot, "t.json");
    const code = await run([
      "mint",
      "--base-url", "https://oob.example.test",
      "--attack-id", "indirect-injection-42",
      "--channel", "markdown-image",
      "--out", tokenFile,
    ]);
    expect(code).toBe(0);

    const token = JSON.parse(fs.readFileSync(tokenFile, "utf8")) as CanaryProofToken;
    expect(token.id).toMatch(/^[0-9a-f]{16}$/);
    expect(token.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(token.attackId).toBe("indirect-injection-42");
    // The bindings adjudicate needs must be IN the file — they are the only
    // copy of the expectation that the report cannot also supply.
    expect(token.receiverId).toBe("local-receiver");
    expect(token.tenantId).toBe("local");
    // …and neither may leak into the locator, which goes out in the payload.
    expect(token.locator).not.toContain("local-receiver");
    // markdown-image payload must actually carry the locator, or nothing can fire.
    expect(out()).toContain(`![status](${token.locator})`);
  });

  it("binds a non-default receiver and tenant into the token file", async () => {
    const tokenFile = path.join(tmpRoot, "t.json");
    const code = await run([
      "mint",
      "--base-url", "https://oob.example.test",
      "--attack-id", "a",
      "--receiver-id", "oob-eu-1",
      "--tenant-id", "tenant-acme",
      "--out", tokenFile,
    ]);
    expect(code).toBe(0);
    const token = JSON.parse(fs.readFileSync(tokenFile, "utf8")) as CanaryProofToken;
    expect(token.receiverId).toBe("oob-eu-1");
    expect(token.tenantId).toBe("tenant-acme");
  });

  it("exits 1 on an unknown channel instead of minting an unusable token", async () => {
    const code = await run([
      "mint", "--base-url", "https://oob.example.test",
      "--attack-id", "a", "--channel", "carrier-pigeon",
      "--out", path.join(tmpRoot, "t.json"),
    ]);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/unknown channel/);
  });
});

describe("attack-proof adjudicate — exit-code contract", () => {
  it("exits 2 PROVEN on a matching, in-window, target-attributable callback", async () => {
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [{
        tokenId: token.id,
        presentedSecret: token.secret,
        observedAtMs: token.issuedAtMs + 10,
        origin: "target",
      }]),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
    ]);
    expect(code).toBe(2);
    expect(out()).toContain("OOB_CONFIRMED");
  });

  it("exits 0 REFUTED only when the operator ATTESTED gap-free coverage and nothing fired", async () => {
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", []),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
    ]);
    expect(code).toBe(0);
    expect(out()).toContain("OOB_EXCLUDED");
  });

  /**
   * THE DEFECT, at the shipped surface.
   *
   * Identical to the test above minus `--receiver-started-at`. That flag used
   * to default to the token file's own `issuedAtMs`, so this exact invocation —
   * a run where NO listener existed — printed
   *
   *     OOB_EXCLUDED  Excluded — receiver watched the entire window, zero callbacks
   *
   * and exited 0. Verified against the built CLI before the fix.
   */
  it("exits 4 NOT-CHECKED — not 0 — when NOBODY attested that a listener ran", async () => {
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", []),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
    ]);
    expect(code).toBe(4);
    expect(out()).toContain("OOB_NOT_CHECKED");
    expect(out()).toContain("receiver-coverage-unattested");
    // The old prose must be gone from this path entirely: it asserted a fact
    // about a receiver that did not exist.
    expect(out()).not.toContain("OOB_EXCLUDED");
    expect(out()).not.toContain("watched the entire validity window");
  });

  it("exits 4 NOT-CHECKED — not 0 — when the receiver declared a coverage gap", async () => {
    // "we blinked" must never green a pipeline as "safe" either.
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", []),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
      "--gap", "listener restarted",
    ]);
    expect(code).toBe(4);
    expect(out()).toContain("OOB_NOT_CHECKED");
  });

  it("exits 3 UNPROVEN when a callback presented the WRONG secret (absence cannot be claimed)", async () => {
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [{
        tokenId: token.id,
        presentedSecret: "f".repeat(32),
        observedAtMs: token.issuedAtMs + 10,
        origin: "target",
      }]),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
    ]);
    expect(code).toBe(3);
    expect(out()).toContain("secret-mismatch");
    // 3 and 4 are different findings for different owners, and the badges have
    // to keep them apart on the terminal too.
    expect(out()).toContain("OOB_INDETERMINATE");
    expect(out()).not.toContain("OOB_NOT_CHECKED");
  });

  it("exits 4 NOT-CHECKED when coverage starts after the token was issued", async () => {
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", []),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      "--receiver-started-at", String(token.issuedAtMs + 1),
    ]);
    expect(code).toBe(4);
    expect(out()).toContain("receiver-coverage-incomplete");
  });

  it("exits 4 NOT-CHECKED when the observations came from a DIFFERENT receiver than the token names", async () => {
    // Unreachable before the binding moved to mint time: `--receiver-id` used
    // to be passed as BOTH the receiver's identity and the expected one, so the
    // comparison was `x !== x`.
    const token = closedWindowToken({ receiverId: "oob-eu-1" });
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [{
        tokenId: token.id,
        presentedSecret: token.secret,
        observedAtMs: token.issuedAtMs + 10,
        origin: "target",
      }]),
      "--receiver-id", "oob-us-1",
      "--tenant-id", TENANT,
      ...attesting(token),
    ]);
    expect(code).toBe(4);
    expect(out()).toContain("receiver-identity-mismatch");
  });

  it("exits 4 NOT-CHECKED when the observations belong to a different tenant", async () => {
    const token = closedWindowToken({ tenantId: "tenant-acme" });
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [{
        tokenId: token.id,
        presentedSecret: token.secret,
        observedAtMs: token.issuedAtMs + 10,
        origin: "target",
      }]),
      "--receiver-id", RECEIVER,
      "--tenant-id", "tenant-globex",
      ...attesting(token),
    ]);
    expect(code).toBe(4);
    expect(out()).toContain("receiver-tenant-mismatch");
  });

  it("exits 1 on a token file with no secret rather than adjudicating something unprovable", async () => {
    const token = closedWindowToken();
    const { secret: _secret, ...noSecret } = token;
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", noSecret),
      "--observations", writeJson("obs.json", []),
    ]);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/not a canary proof token/);
  });

  it("exits 1 on a token file with no receiver or tenant binding", async () => {
    const { receiverId: _r, tenantId: _t, ...unbound } = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", unbound),
      "--observations", writeJson("obs.json", []),
    ]);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/receiverId, tenantId/);
  });

  it("records an in-band echo WITHOUT letting it change the state", async () => {
    // A model printing the locator is not the same as something fetching it.
    const token = closedWindowToken();
    const outputFile = path.join(tmpRoot, "target.txt");
    fs.writeFileSync(outputFile, `Sure! ![status](${token.locator})`);
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", []),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
      "--target-output", outputFile,
    ]);
    expect(code).toBe(0); // still REFUTED — the echo carries no proof weight
    expect(out()).toContain("IN-BAND ONLY");
  });

  it("every exit code the command can produce is distinct", () => {
    // Cheap, but it is the whole CI contract: two states sharing a code is how
    // `unverifiable` would quietly become `unproven` again.
    const src = fs.readFileSync(path.join(__dirname, "..", "attack-proof.ts"), "utf8");
    const codes = [...src.matchAll(/^const EXIT_(\w+) = (\d+);$/gm)].map((m) => Number(m[2]));
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
  });
});

/**
 * The module's two halves, connected by the documented path.
 *
 * `collectCanaryInteraction()` is how core says to turn a listener's HTTP/DNS/
 * SMTP record into an observation, and this command is what adjudicates them.
 * Its output used to be REJECTED here — `observation[0] needs string origin +
 * channel`, exit 1 — because the CLI required a `channel` field that
 * `CallbackObservation` does not have and the collector therefore never emits.
 * The channel belongs to the TOKEN. Anyone following the docs hit a wall.
 */
describe("attack-proof adjudicate — accepts our own collector's output", () => {
  it("adjudicates collectCanaryInteraction() output verbatim, to PROVEN", async () => {
    const token = closedWindowToken();
    const collected = collectCanaryInteraction(
      {
        protocol: "http",
        target: `/eg-canary/${token.id}?k=${token.secret}`,
        method: "GET",
        headers: { "user-agent": "target-agent/1.0" },
        sourceIp: "203.0.113.7",
        observedAtMs: token.issuedAtMs + 10,
      },
      { targetSourceIps: ["203.0.113.7"] },
    );
    expect(collected.matched).toBe(true);
    if (!collected.matched) return;
    // Not a hand-written fixture: the collector's object, serialised as-is.
    expect(collected.observation).not.toHaveProperty("channel");

    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [collected.observation]),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
    ]);
    expect(code).toBe(2);
    expect(out()).toContain("OOB_CONFIRMED");
  });

  it("still accepts an observations file that DOES carry a channel, and ignores it", async () => {
    // Back-compat control: anything already writing the field keeps working,
    // and the stray key does not travel onto the verdict.
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [{
        tokenId: token.id,
        presentedSecret: token.secret,
        observedAtMs: token.issuedAtMs + 10,
        origin: "target",
        channel: "http-fetch",
      }]),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
      ...attesting(token),
      "--json",
    ]);
    expect(code).toBe(2);
    const verdict = JSON.parse(out()) as { provingObservations: Record<string, unknown>[] };
    expect(verdict.provingObservations).toHaveLength(1);
    expect(verdict.provingObservations[0]).not.toHaveProperty("channel");
  });

  it("still refuses an observation that is missing a REAL required field", async () => {
    // Control: relaxing `channel` must not have relaxed the validator itself.
    const token = closedWindowToken();
    const code = await run([
      "adjudicate",
      "--token", writeJson("t.json", token),
      "--observations", writeJson("obs.json", [{
        tokenId: token.id,
        presentedSecret: token.secret,
        observedAtMs: token.issuedAtMs + 10,
      }]),
      "--receiver-id", RECEIVER,
      "--tenant-id", TENANT,
    ]);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/needs a string origin/);
  });
});
