/**
 * Credential at rest — the OS credential store, and the config file that must
 * no longer contain the key.
 *
 * Audit 2026-08-06: `~/.evalguard/config.json` held the API key VERBATIM,
 * defended only by `{ mode: 0o600 }`. 0600 is a permission, not encryption —
 * and on Windows Node's `mode` is very nearly a no-op (only the read-only bit
 * is honoured), so on the platform this suite runs on there was no control at
 * all.
 *
 * These tests use a REAL config file in a temp dir and, on Windows, the REAL
 * DPAPI round trip through the REAL powershell.exe. The whole risk of this
 * change is what the bytes on disk look like afterwards, and a mocked
 * credential store cannot fail the way a real one can. The macOS/Linux
 * backends are pinned at the argv+stdin level through the injected command
 * runner — the shapes are asserted, but (honestly) they have NOT been executed
 * against a real Keychain or Secret Service daemon.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  deleteProfile,
  describeProtection,
  getProfile,
  loadConfig,
  loadConfigFile,
  plaintextRemedy,
  profileSecretProtection,
  resolveApiKey,
  saveActiveProfile,
  upsertProfile,
} from "../config.js";
import {
  SECRET_SERVICE,
  __setCommandRunner,
  backendPreference,
  isProtectedSecret,
  keyringAccount,
  platformDefaultBackend,
  protectSecret,
  resetSecretStoreState,
  unprotectSecret,
  type CommandRunner,
  type ProtectedSecret,
  type RunResult,
} from "../secret-store.js";
import { plaintextWarning, profileRows } from "../../commands/profile.js";

const ENV_KEYS = [
  "EVALGUARD_CONFIG_FILE",
  "EVALGUARD_PROFILE",
  "EVALGUARD_API_KEY",
  "EVALGUARD_BASE_URL",
  "EVALGUARD_SECRET_BACKEND",
] as const;

/** A key shaped like a real one, and long enough that a substring hit is meaningful. */
const SECRET = "eg_live_9f2b7c41d8a640e5b3116ee0cafe1234";

const IS_WIN = process.platform === "win32";
const onWindows = IS_WIN ? it : it.skip;

let tmpDir: string;
let configFile: string;
const savedEnv: Record<string, string | undefined> = {};
const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configFile, "utf-8")) as Record<string, unknown>;
}

function rawBytes(): string {
  return fs.readFileSync(configFile, "utf-8");
}

/** Collect stderr warnings for the duration of `fn`. */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg?: unknown) => void warnings.push(String(msg));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/* ── a fake OS keyring, so the unix backends are exercised off-platform ──── */

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "not found"): RunResult => ({ status: 1, stdout: "", stderr });

interface FakeKeyring {
  run: CommandRunner;
  entries: Map<string, string>;
  calls: { bin: string; args: string[]; input?: string }[];
}

function fakeKeyring(): FakeKeyring {
  const entries = new Map<string, string>();
  const calls: { bin: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (bin, args, input) => {
    calls.push({ bin, args, input });
    const after = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";

    if (bin === "secret-tool") {
      if (args[0] === "--version") return ok("secret-tool 0.20.5\n");
      const account = after("account");
      if (args[0] === "store") {
        entries.set(account, (input ?? "").replace(/\n$/, ""));
        return ok();
      }
      if (args[0] === "lookup") {
        const v = entries.get(account);
        return v === undefined ? fail() : ok(v);
      }
      if (args[0] === "clear") {
        entries.delete(account);
        return ok();
      }
    }

    if (bin === "security") {
      const account = after("-a");
      if (args[0] === "add-generic-password") {
        entries.set(account, (input ?? "").split("\n")[0] ?? "");
        return ok();
      }
      if (args[0] === "find-generic-password") {
        const v = entries.get(account);
        return v === undefined ? fail() : ok(`${v}\n`);
      }
      if (args[0] === "delete-generic-password") {
        entries.delete(account);
        return ok();
      }
    }
    return fail(`unexpected command: ${bin} ${args.join(" ")}`);
  };
  return { run, entries, calls };
}

/**
 * Install a WORKING credential store, whatever the host OS is.
 *
 * ── Why this exists (CI failure 2026-08-06, deploy run 31129834902) ──
 *
 * `platformDefaultBackend()` reads the ambient machine. On the authoring box
 * (Windows) that is DPAPI, so every assertion below about "the key is not in
 * the file" held. On the ubuntu-24.04 runner there is no `secret-tool`, so
 * `auto` correctly resolves to `plaintext`, the key IS written in the clear,
 * and ten tests failed — `expected '{"version":2,…' not to contain 'eg_live_…'`.
 *
 * That is the TEST being wrong, not the product: writing plaintext on a box
 * with no credential store is the documented, deliberate contract (see the
 * "Honesty rule" block in secret-store.ts — there is no home-made-crypto
 * fallback on purpose). Asserting "never plaintext" unconditionally asserts a
 * guarantee the module never made.
 *
 * So the protected-path tests pin an INJECTED keyring instead of the ambient
 * one. That is strictly more coverage, not less: those assertions previously
 * ran on Windows only and ran nowhere on Linux/macOS CI. Nothing is skipped to
 * get there —
 *   - the store-less fallback keeps its own test ("an unavailable store in AUTO
 *     mode falls back to plaintext — loudly, never silently"), and
 *   - the real, un-mocked platform store is still exercised by the `onRealStore`
 *     and `onWindows` tests below, which run wherever a real store exists.
 */
function useProtectedBackend(): FakeKeyring {
  setPlatform("linux");
  const keyring = fakeKeyring();
  __setCommandRunner(keyring.run);
  resetSecretStoreState();
  return keyring;
}

/**
 * Does the machine running this suite have a REAL OS credential store? Probed
 * with the real runner, before any injection. False on a bare Linux container,
 * true on Windows/macOS and on a Linux box with libsecret installed.
 */
const HAS_REAL_STORE = ((): boolean => {
  __setCommandRunner(null);
  resetSecretStoreState();
  return platformDefaultBackend() !== "plaintext";
})();
const onRealStore = HAS_REAL_STORE ? it : it.skip;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-cli-secret-"));
  configFile = path.join(tmpDir, "config.json");
  process.env.EVALGUARD_CONFIG_FILE = configFile;
  resetSecretStoreState();
});

afterEach(() => {
  __setCommandRunner(null);
  setPlatform(realPlatform);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetSecretStoreState();
});

/* ══ 1. the real platform backend, on this box ═════════════════════════════ */

describe("REAL platform backend round trip (no mocks)", () => {
  onWindows("DPAPI encrypts and decrypts through real powershell.exe", () => {
    expect(platformDefaultBackend()).toBe("dpapi");

    const result = protectSecret(SECRET, { configFile, profile: "prod" });
    expect(result.kind).toBe("protected");
    if (result.kind !== "protected") return;

    expect(result.backend).toBe("dpapi");
    expect(result.secret.ciphertext).toBeTruthy();
    // A DPAPI blob is opaque bytes, not an encoding of the input.
    expect(result.secret.ciphertext).not.toContain(SECRET);
    expect(Buffer.from(result.secret.ciphertext as string, "base64").toString("latin1")).not.toContain(
      SECRET,
    );

    expect(unprotectSecret(result.secret)).toBe(SECRET);
  });

  onWindows("a corrupted DPAPI blob yields undefined + a warning, never a crash", () => {
    const result = protectSecret(SECRET, { configFile, profile: "prod" });
    if (result.kind !== "protected") throw new Error("expected DPAPI to be available");

    const bytes = Buffer.from(result.secret.ciphertext as string, "base64");
    bytes[bytes.length - 5] ^= 0xff; // what a foreign machine's blob looks like
    const tampered: ProtectedSecret = { ...result.secret, ciphertext: bytes.toString("base64") };

    resetSecretStoreState();
    const { result: value, warnings } = captureWarnings(() => unprotectSecret(tampered));
    expect(value).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/could not read the stored API key/i);
    expect(warnings.join("\n")).toMatch(/evalguard login/);
  });

  onWindows("two encryptions of the same key differ (DPAPI is not a deterministic encoding)", () => {
    const a = protectSecret(SECRET, { configFile, profile: "prod" });
    const b = protectSecret(SECRET, { configFile, profile: "prod" });
    if (a.kind !== "protected" || b.kind !== "protected") throw new Error("expected DPAPI");
    expect(a.secret.ciphertext).not.toBe(b.secret.ciphertext);
  });
});

/* ══ 2. THE pinning test: the file must not contain the key ════════════════ */

describe("the config file no longer contains the API key", () => {
  /** The single assertion that pins the whole change, factored so the injected
   *  store and this machine's real one are held to exactly the same bar. */
  function expectLoginLeavesNoTrace(): void {
    // This is exactly what `login` / `profile create --key` do.
    upsertProfile("prod", { apiKey: SECRET, baseUrl: "https://evalguard.ai/api/v1" }, { switchTo: true });

    const bytes = rawBytes();
    // Revert the encryption and this fails on every platform that has a
    // credential store.
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain("eg_live_9f2b7c41"); // not even a prefix
    // …and the non-secret fields are still there, so nothing else regressed.
    expect(bytes).toContain("https://evalguard.ai/api/v1");

    const stored = getProfile("prod", loadConfigFile());
    expect(stored.apiKey).toBeUndefined();
    expect(isProtectedSecret(stored.apiKeyEnc)).toBe(true);
    expect(profileSecretProtection(stored)).toBe(platformDefaultBackend());

    // Transparent to every subcommand: resolution still returns the real key.
    expect(resolveApiKey()).toBe(SECRET);
    expect(loadConfig().apiKeyEnc).toBeDefined();
  }

  it("`evalguard login`'s write leaves no trace of the secret on disk", () => {
    useProtectedBackend();
    expectLoginLeavesNoTrace();
  });

  onRealStore("REAL backend: the same holds through this machine's actual credential store", () => {
    // No injection: DPAPI on Windows, Keychain on macOS, a real Secret Service
    // where one is installed. Skipped — not silently passed — on a host with no
    // store, because there the module's contract is plaintext, pinned below.
    expectLoginLeavesNoTrace();
  });

  it("the back-compat top-level MIRROR carries no plaintext key either", () => {
    useProtectedBackend();
    upsertProfile("prod", { apiKey: SECRET, baseUrl: "https://evalguard.ai/api/v1", projectId: "p1" }, {
      switchTo: true,
    });

    // A pinned older CLI reads the top level of this file. It must find the
    // non-secret fields (unchanged behaviour) but NOT a decrypted copy of the
    // key sitting beside the ciphertext — that would make the whole exercise
    // theatre. It is the deliberate cost of encrypting at all.
    const asOldCliSeesIt = readRaw() as { apiKey?: string; baseUrl?: string; projectId?: string };
    expect(asOldCliSeesIt.apiKey).toBeUndefined();
    expect(asOldCliSeesIt.baseUrl).toBe("https://evalguard.ai/api/v1");
    expect(asOldCliSeesIt.projectId).toBe("p1");
  });

  it("every profile is protected, not just the active one", () => {
    useProtectedBackend();
    upsertProfile("saas", { apiKey: `${SECRET}_A` }, { switchTo: true });
    upsertProfile("self-hosted", { apiKey: `${SECRET}_B` });

    const bytes = rawBytes();
    expect(bytes).not.toContain(`${SECRET}_A`);
    expect(bytes).not.toContain(`${SECRET}_B`);

    const file = loadConfigFile();
    expect(isProtectedSecret(getProfile("saas", file).apiKeyEnc)).toBe(true);
    expect(isProtectedSecret(getProfile("self-hosted", file).apiKeyEnc)).toBe(true);
  });

  it("rotating the key retires the previous secret instead of keeping both", () => {
    useProtectedBackend();
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    const first = getProfile("prod", loadConfigFile()).apiKeyEnc as ProtectedSecret;

    const rotated = "eg_live_ROTATED_00000000000000000000";
    upsertProfile("prod", { apiKey: rotated }); // what `evalguard login --key` does

    const stored = getProfile("prod", loadConfigFile());
    expect(stored.apiKey).toBeUndefined();
    expect(resolveApiKey()).toBe(rotated);
    expect(rawBytes()).not.toContain(rotated);

    // What "retired" means is backend-shaped, so assert the INVARIANT rather
    // than one backend's expression of it:
    //   - dpapi carries its ciphertext IN the file, so the envelope must change;
    //   - a keyring backend carries only a stable ref (`keyringAccount` is a
    //     hash of config-file + profile, deterministic on purpose so re-login
    //     overwrites one entry instead of littering the user's Keychain), so the
    //     envelope legitimately does NOT change and the STORE entry must.
    // Both must guarantee the same thing: the retired key is no longer
    // recoverable. Otherwise resolution keeps sending a REVOKED key while the
    // user believes they rotated.
    expect(unprotectSecret(first)).not.toBe(SECRET);
    expect(unprotectSecret(first)).toBe(rotated);
    if (first.ciphertext !== undefined) {
      expect(stored.apiKeyEnc).not.toEqual(first);
    }
  });
});

/* ══ 3. legacy plaintext still resolves ═══════════════════════════════════ */

describe("backwards compatibility — a plaintext config is never stranded", () => {
  const LEGACY_FLAT = {
    apiKey: "eg_live_legacyPlaintextKey0987654321",
    baseUrl: "https://evalguard.ai/api/v1",
    projectId: "proj_legacy",
  };

  it("a pre-encryption flat config still resolves, and says how to upgrade", () => {
    // "how to upgrade" only exists when there is something to upgrade TO, so
    // this is the store-available branch. The no-store branch of the same nudge
    // is asserted in "the plaintext nudge tells the truth in each of the three
    // situations", case (c).
    useProtectedBackend();
    fs.writeFileSync(configFile, JSON.stringify(LEGACY_FLAT, null, 2));

    const { result, warnings } = captureWarnings(() => resolveApiKey());
    expect(result).toBe(LEGACY_FLAT.apiKey); // NOT stranded
    expect(warnings.join("\n")).toMatch(/PLAINTEXT/);
    expect(warnings.join("\n")).toMatch(/evalguard login/);
  });

  it("reading a legacy config does not rewrite it (read-only homes keep working)", () => {
    fs.writeFileSync(configFile, JSON.stringify(LEGACY_FLAT, null, 2));
    const before = rawBytes();
    captureWarnings(() => {
      resolveApiKey();
      loadConfig();
      loadConfigFile();
    });
    expect(rawBytes()).toBe(before);
  });

  it("the next SAVE re-writes the legacy key protected, losing nothing else", () => {
    useProtectedBackend();
    fs.writeFileSync(
      configFile,
      JSON.stringify({ ...LEGACY_FLAT, openaiApiKey: "sk-legacy", somethingFuture: 42 }, null, 2),
    );

    // Any write at all — here, a base-URL change that never mentions the key.
    captureWarnings(() => saveActiveProfile({ baseUrl: "https://eg.corp.internal/api/v1" }));

    expect(rawBytes()).not.toContain(LEGACY_FLAT.apiKey);
    const stored = getProfile("default", loadConfigFile());
    expect(stored.apiKey).toBeUndefined();
    expect(isProtectedSecret(stored.apiKeyEnc)).toBe(true);
    expect(stored.projectId).toBe("proj_legacy");
    expect(stored.openaiApiKey).toBe("sk-legacy");
    expect(stored.somethingFuture).toBe(42);
    expect(resolveApiKey()).toBe(LEGACY_FLAT.apiKey);
  });

  it("a plaintext key on a profile loses to a protected one on the same profile", () => {
    useProtectedBackend();
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    // Hand-edit a stale plaintext key back in beside the envelope.
    const raw = readRaw() as { profiles: Record<string, Record<string, unknown>> };
    raw.profiles.prod.apiKey = "eg_live_STALE_LEFTOVER_000000000000";
    fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));

    expect(resolveApiKey()).toBe(SECRET);
  });
});

/* ══ 4. EVALGUARD_API_KEY still wins ══════════════════════════════════════ */

describe("precedence — EVALGUARD_API_KEY still beats anything stored", () => {
  it("overrides a PROTECTED profile key", () => {
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    process.env.EVALGUARD_API_KEY = "eg_from_env_0987654321";
    expect(resolveApiKey()).toBe("eg_from_env_0987654321");
  });

  it("overrides a LEGACY PLAINTEXT profile key", () => {
    fs.writeFileSync(configFile, JSON.stringify({ apiKey: "eg_plain_0000000000" }));
    process.env.EVALGUARD_API_KEY = "eg_from_env_0987654321";
    const { result, warnings } = captureWarnings(() => resolveApiKey());
    expect(result).toBe("eg_from_env_0987654321");
    // And it short-circuits before the plaintext nag, because there is nothing
    // for the user to act on: the stored key is not being used.
    expect(warnings).toEqual([]);
  });

  it("never touches the credential store when the env var is set (CI pays nothing)", () => {
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    process.env.EVALGUARD_API_KEY = "eg_from_env_0987654321";

    let spawned = 0;
    __setCommandRunner((bin, args, input) => {
      spawned += 1;
      return fail(`refused: ${bin} ${args.join(" ")} ${input ? "(with stdin)" : ""}`);
    });
    expect(resolveApiKey()).toBe("eg_from_env_0987654321");
    expect(spawned).toBe(0);
  });
});

/* ══ 5. EVALGUARD_SECRET_BACKEND ══════════════════════════════════════════ */

describe("EVALGUARD_SECRET_BACKEND", () => {
  it("=plaintext stores the key in the clear, under the honest field name, loudly", () => {
    process.env.EVALGUARD_SECRET_BACKEND = "plaintext";
    expect(backendPreference()).toEqual({ name: "plaintext", forced: true });

    const { warnings } = captureWarnings(() =>
      upsertProfile("ci", { apiKey: SECRET }, { switchTo: true }),
    );

    const stored = getProfile("ci", loadConfigFile());
    // The key is in the clear — and the field is called `apiKey`, not
    // `apiKeyEnc`. Presence of `apiKeyEnc` is a truthful claim of protection.
    expect(stored.apiKey).toBe(SECRET);
    expect(stored.apiKeyEnc).toBeUndefined();
    expect(rawBytes()).toContain(SECRET);
    expect(profileSecretProtection(stored)).toBe("plaintext");
    // Explicit, but never silent.
    expect(warnings.join("\n")).toMatch(/UNENCRYPTED/);
    // …and it is never described as encryption anywhere the user can see.
    expect(describeProtection("plaintext")).toBe("plaintext — NOT encrypted");
    expect(resolveApiKey()).toBe(SECRET);
  });

  it("=plaintext still DECRYPTS an already-protected key (reads follow the envelope)", () => {
    useProtectedBackend(); // there must BE a protected key for the read to follow
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    expect(rawBytes()).not.toContain(SECRET);

    // Setting the var must not strand the key the user already has.
    process.env.EVALGUARD_SECRET_BACKEND = "plaintext";
    resetSecretStoreState();
    expect(resolveApiKey()).toBe(SECRET);
  });

  it("an explicitly-named backend that is unavailable HARD FAILS instead of downgrading", () => {
    // The failure this exists to prevent: an operator sets a backend, it does
    // not work, and the CLI quietly writes the key in the clear anyway.
    __setCommandRunner(() => fail("no keychain here"));
    process.env.EVALGUARD_SECRET_BACKEND = "keychain";

    expect(() => upsertProfile("prod", { apiKey: SECRET }, { switchTo: true })).toThrow(
      /Refusing to silently store the API key in plaintext/,
    );
    // Nothing half-written, and no stray directory: the failure happens before
    // the filesystem is touched at all.
    expect(fs.existsSync(configFile)).toBe(false);
    const nested = path.join(tmpDir, "made-up-dir", "config.json");
    expect(() => upsertProfile("prod", { apiKey: SECRET }, { file: nested })).toThrow();
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
  });

  it("an unknown value is rejected on WRITE but never breaks a READ", () => {
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    process.env.EVALGUARD_SECRET_BACKEND = "rot13";
    resetSecretStoreState();

    expect(() => backendPreference()).toThrow(/Unknown EVALGUARD_SECRET_BACKEND/);
    expect(() => upsertProfile("other", { apiKey: SECRET })).toThrow(/Unknown EVALGUARD_SECRET_BACKEND/);
    // A typo in an env var must not read as "all my credentials are gone" —
    // but it must not be swallowed either. `EVALGUARD_SECRET_BACKEND=plaintxt`
    // otherwise means the user believes they forced plaintext and silently did
    // not.
    const { result, warnings } = captureWarnings(() => resolveApiKey());
    expect(result).toBe(SECRET);
    expect(warnings.join("\n")).toMatch(/ignoring unknown EVALGUARD_SECRET_BACKEND/);
  });

  it("the plaintext nudge tells the truth in each of the three situations", () => {
    // Saying the wrong one is its own small dishonesty. The bugs this pins:
    // "re-store it with plaintext — NOT encrypted" (nonsense advice), and
    // "no credential store is available" on a Windows box that has DPAPI and
    // was merely told to use plaintext.

    // Cases (a) and (b) are both "a store EXISTS" branches, so one must exist
    // regardless of host. Case (c) below installs its own store-less world.
    useProtectedBackend();

    // (a) a store exists and would be used → offer the upgrade, name it.
    expect(plaintextRemedy()).toMatch(/evalguard login/);
    expect(plaintextRemedy()).toContain(describeProtection(platformDefaultBackend()));
    expect(plaintextRemedy()).not.toMatch(/NOT encrypted/);

    // (b) a store exists but the user forced plaintext → say THAT, not "none
    //     available".
    process.env.EVALGUARD_SECRET_BACKEND = "plaintext";
    resetSecretStoreState();
    const forced = plaintextRemedy();
    expect(forced).toMatch(/EVALGUARD_SECRET_BACKEND=plaintext is set/);
    expect(forced).not.toMatch(/No OS credential store is available/);

    // (c) genuinely no store on this platform → say that, and point at the
    //     option that never writes to disk.
    delete process.env.EVALGUARD_SECRET_BACKEND;
    setPlatform("linux");
    __setCommandRunner(() => fail("no secret-tool"));
    resetSecretStoreState();
    const none = plaintextRemedy();
    expect(none).toMatch(/No OS credential store is available/);
    expect(none).toMatch(/EVALGUARD_API_KEY/);
    expect(none).not.toMatch(/re-store it with plaintext/);

    // …and it is what actually reaches the user on a legacy plaintext read.
    fs.writeFileSync(configFile, JSON.stringify({ apiKey: SECRET }));
    const { result, warnings } = captureWarnings(() => resolveApiKey());
    expect(result).toBe(SECRET);
    expect(warnings.join("\n")).toContain(none);
  });

  it("an unavailable store in AUTO mode falls back to plaintext — loudly, never silently", () => {
    setPlatform("linux");
    __setCommandRunner(() => fail("secret-tool: command not found"));
    resetSecretStoreState();

    expect(platformDefaultBackend()).toBe("plaintext");
    const { warnings } = captureWarnings(() =>
      upsertProfile("prod", { apiKey: SECRET }, { switchTo: true }),
    );

    expect(getProfile("prod", loadConfigFile()).apiKey).toBe(SECRET);
    const text = warnings.join("\n");
    expect(text).toMatch(/IN PLAINTEXT/);
    expect(text).toMatch(/File permissions are not encryption/);
    expect(text).toMatch(/EVALGUARD_API_KEY/);
  });
});

/* ══ 6. the unix backends (argv/stdin shape, injected runner) ═════════════ */

describe("keyring backends — command shape and secret handling", () => {
  it("libsecret: stores via stdin, keeps only a ref in the file, and round-trips", () => {
    setPlatform("linux");
    const keyring = fakeKeyring();
    __setCommandRunner(keyring.run);
    resetSecretStoreState();

    expect(platformDefaultBackend()).toBe("libsecret");
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });

    expect(rawBytes()).not.toContain(SECRET);
    const stored = getProfile("prod", loadConfigFile()).apiKeyEnc as ProtectedSecret;
    expect(stored.backend).toBe("libsecret");
    expect(stored.ciphertext).toBeUndefined(); // the secret is NOT in the file
    expect(stored.ref).toBe(keyringAccount({ configFile, profile: "prod" }));
    expect(keyring.entries.get(stored.ref as string)).toBe(SECRET);

    const store = keyring.calls.find((c) => c.args[0] === "store");
    expect(store?.bin).toBe("secret-tool");
    expect(store?.args).toEqual([
      "store",
      "--label",
      "EvalGuard CLI (prod)",
      "service",
      SECRET_SERVICE,
      "account",
      stored.ref,
    ]);
    // The secret goes over STDIN. An argv element is readable by every other
    // process on the box for the lifetime of the spawn.
    expect(store?.input).toBe(`${SECRET}\n`);
    expect(store?.args.join(" ")).not.toContain(SECRET);

    resetSecretStoreState();
    expect(resolveApiKey()).toBe(SECRET);
  });

  it("keychain: stores via stdin, keeps only a ref in the file, and round-trips", () => {
    setPlatform("darwin");
    const keyring = fakeKeyring();
    __setCommandRunner(keyring.run);
    resetSecretStoreState();

    expect(platformDefaultBackend()).toBe("keychain");
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });

    expect(rawBytes()).not.toContain(SECRET);
    const stored = getProfile("prod", loadConfigFile()).apiKeyEnc as ProtectedSecret;
    expect(stored.backend).toBe("keychain");
    expect(stored.ciphertext).toBeUndefined();

    const add = keyring.calls.find((c) => c.args[0] === "add-generic-password");
    expect(add?.bin).toBe("security");
    expect(add?.args).toEqual([
      "add-generic-password",
      "-U", // update in place rather than errSecDuplicateItem
      "-s",
      SECRET_SERVICE,
      "-a",
      stored.ref,
      "-l",
      "EvalGuard CLI (prod)",
      "-w", // no value: read the password from stdin
    ]);
    expect(add?.args.join(" ")).not.toContain(SECRET);
    expect(add?.input?.split("\n")[0]).toBe(SECRET);

    resetSecretStoreState();
    expect(resolveApiKey()).toBe(SECRET);
  });

  it("the keyring ref is a stable, non-reversible hash — no home path, no key", () => {
    const ref = keyringAccount({ configFile, profile: "prod" });
    expect(ref).toMatch(/^eg-[0-9a-f]{32}$/);
    expect(ref).toBe(keyringAccount({ configFile, profile: "prod" })); // stable
    expect(ref).not.toBe(keyringAccount({ configFile, profile: "stage" }));
    expect(ref).not.toContain(os.homedir());
  });

  it("deleting a profile purges the keyring entry instead of orphaning it", () => {
    setPlatform("linux");
    const keyring = fakeKeyring();
    __setCommandRunner(keyring.run);
    resetSecretStoreState();

    upsertProfile("a", { apiKey: `${SECRET}_A` }, { switchTo: true });
    upsertProfile("b", { apiKey: `${SECRET}_B` });
    const refB = keyringAccount({ configFile, profile: "b" });
    expect(keyring.entries.has(refB)).toBe(true);

    deleteProfile("b");
    expect(keyring.entries.has(refB)).toBe(false);
    expect(keyring.entries.has(keyringAccount({ configFile, profile: "a" }))).toBe(true);
  });

  it("a keyring entry that vanished degrades to undefined + a warning, not a throw", () => {
    setPlatform("linux");
    const keyring = fakeKeyring();
    __setCommandRunner(keyring.run);
    resetSecretStoreState();

    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });
    keyring.entries.clear(); // user emptied their keyring / it is locked
    resetSecretStoreState();

    const { result, warnings } = captureWarnings(() => resolveApiKey());
    expect(result).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/could not read the stored API key/i);
  });
});

/* ══ 7. `profile list` / `current` never print the secret ═════════════════ */

describe("display — the secret is never printed, and protection is labelled honestly", () => {
  it("a protected profile renders a label, and never decrypts to do it", () => {
    useProtectedBackend();
    upsertProfile("prod", { apiKey: SECRET }, { switchTo: true });

    // Any spawn here would be a decrypt just to draw a table (and, on macOS, a
    // Keychain prompt for a read-only command).
    let spawned = 0;
    __setCommandRunner((bin, args) => {
      spawned += 1;
      return fail(`refused: ${bin} ${args.join(" ")}`);
    });

    const rows = profileRows(loadConfigFile());
    expect(spawned).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].protection).toBe(platformDefaultBackend());
    expect(rows[0].apiKey).toBe(`(protected: ${platformDefaultBackend()})`);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(SECRET.slice(0, 12));
    expect(plaintextWarning(rows)).toBeUndefined();
  });

  it("a plaintext profile is masked AND flagged, not quietly shown as normal", () => {
    process.env.EVALGUARD_SECRET_BACKEND = "plaintext";
    captureWarnings(() => upsertProfile("legacy", { apiKey: SECRET }, { switchTo: true }));

    const rows = profileRows(loadConfigFile());
    expect(rows[0].protection).toBe("plaintext");
    expect(rows[0].apiKey).toContain("(plaintext)");
    expect(rows[0].apiKey).not.toContain(SECRET);
    expect(rows[0].apiKey).not.toContain("9f2b7c41");

    const warning = plaintextWarning(rows);
    expect(warning).toMatch(/UNENCRYPTED/);
    expect(warning).toMatch(/legacy/);
  });

  it("a profile with no key at all says so", () => {
    upsertProfile("empty", { baseUrl: "https://evalguard.ai/api/v1" }, { switchTo: true });
    const rows = profileRows(loadConfigFile());
    expect(rows[0].protection).toBe("none");
    expect(rows[0].apiKey).toBe("(not set)");
  });
});
