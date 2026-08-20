/**
 * At-rest protection for the API keys `evalguard login` / `evalguard profile
 * create` persist.
 *
 * ── The problem this closes ────────────────────────────────────────────────
 *
 * `~/.evalguard/config.json` used to hold the API key VERBATIM, protected by
 * nothing but `fs.writeFileSync(..., { mode: 0o600 })`. Two holes:
 *
 *   1. 0600 is a permission, not encryption. Anything running as that user —
 *      a malicious `postinstall` script, a leaked home-directory backup, a
 *      Dropbox/OneDrive folder that syncs `~`, an `rsync` to a shared box —
 *      reads `eg_…` straight out of the file.
 *   2. On Windows, Node's `mode` argument is very nearly a no-op: only the
 *      read-only bit is honoured, ACLs are untouched. So on the platform a
 *      large share of CLI users are on, the one control that existed did not
 *      exist at all.
 *
 * ── What this module does ─────────────────────────────────────────────────
 *
 * Hands the secret to the OS credential store the platform already ships,
 * with NO native module (nothing that needs a compiler at install time):
 *
 *   Windows  `dpapi`     — System.Security.Cryptography.ProtectedData with
 *                          DataProtectionScope.CurrentUser, driven through
 *                          powershell.exe. The ciphertext is a real DPAPI
 *                          blob: the key material derives from the user's
 *                          logon credentials and the machine's DPAPI master
 *                          key, neither of which is in the config file. It is
 *                          stored INSIDE config.json because that is all it
 *                          is — ciphertext another user or another machine
 *                          cannot unwrap.
 *   macOS    `keychain`  — `security add-generic-password` /
 *                          `find-generic-password`. The secret leaves the
 *                          file entirely; config.json keeps only a lookup ref.
 *   Linux    `libsecret` — `secret-tool store` / `secret-tool lookup`, when
 *                          the binary is present (GNOME Keyring / KWallet via
 *                          the Secret Service D-Bus API). Ref only, as above.
 *   any      `plaintext` — the key, in the clear, under the field name
 *                          `apiKey`. Honest by construction.
 *
 * ── Honesty rule (deliberate non-feature) ─────────────────────────────────
 *
 * There is NO "encrypt it with a key we ship / derive from the machine and
 * store next to the ciphertext" fallback. That is obfuscation wearing an
 * encryption costume, and the only thing worse than plaintext is plaintext a
 * user believes is encrypted. When no OS credential store can be used the
 * secret is written in the clear, the field is literally called `apiKey`, and
 * the CLI says so on stderr and in `evalguard profile current`.
 *
 * ── Backend selection ─────────────────────────────────────────────────────
 *
 *   EVALGUARD_SECRET_BACKEND = auto | dpapi | keychain | libsecret | plaintext
 *
 *   - unset / `auto`  → the platform default above; if it is unavailable or
 *                       errors, fall back to `plaintext` with a LOUD stderr
 *                       warning. Never a silent downgrade.
 *   - an explicit name → that backend, or a hard error. An operator who asked
 *                       for `keychain` must not silently get plaintext.
 *   - `plaintext`      → plaintext, no warning about the fallback (they asked)
 *                        but still labelled as plaintext everywhere it shows.
 *                        This is the CI-container / read-only-image escape
 *                        hatch, though `EVALGUARD_API_KEY` is better there:
 *                        it never touches disk at all.
 *
 * READS follow the stored envelope, not the preference: a config protected
 * with DPAPI still decrypts while `EVALGUARD_SECRET_BACKEND=plaintext` is set,
 * because otherwise setting that var would strand the user's existing key.
 * The preference only decides how the NEXT write is stored.
 *
 * ── Verification status (read this before trusting a platform) ────────────
 *
 * The DPAPI path is exercised end-to-end (real encrypt + real decrypt through
 * real powershell.exe) by `__tests__/secret-store.test.ts` and was verified on
 * the authoring machine. The `keychain` and `libsecret` paths are pinned by
 * tests only at the argv/stdin level through an injected command runner — the
 * command shapes are asserted, but they have NOT been executed against a real
 * Keychain or a real Secret Service daemon. If either misbehaves in the field
 * it fails CLOSED into the loud plaintext fallback (auto) or a hard error
 * (explicitly selected), never into a silent partial write.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as path from "path";

/** Every backend name `EVALGUARD_SECRET_BACKEND` accepts (besides `auto`). */
export const SECRET_BACKENDS = ["dpapi", "keychain", "libsecret", "plaintext"] as const;
export type SecretBackendName = (typeof SECRET_BACKENDS)[number];

/** The backends that actually protect something. `plaintext` is not one. */
export type KeyringBackendName = Exclude<SecretBackendName, "plaintext">;

/** Service name filed in the macOS Keychain / Secret Service collection. */
export const SECRET_SERVICE = "evalguard-cli";

/** Envelope schema version, so a future format change is detectable on read. */
export const PROTECTED_SECRET_VERSION = 1;

/**
 * What goes into config.json in place of the raw key.
 *
 * `dpapi` carries its own ciphertext; the keyring backends carry only a
 * lookup ref, because the secret lives in the OS store. Neither shape contains
 * anything that can recover the key on its own.
 */
export interface ProtectedSecret {
  v: number;
  backend: KeyringBackendName;
  /** dpapi only: base64 of the DPAPI blob. */
  ciphertext?: string;
  /** keychain / libsecret only: the account the secret is filed under. */
  ref?: string;
}

/** Which config file + profile a secret belongs to (makes the keyring ref stable). */
export interface SecretRef {
  configFile: string;
  profile: string;
}

/** Outcome of trying to protect a secret. `plaintext` is a first-class result. */
export type ProtectResult =
  | { kind: "protected"; secret: ProtectedSecret; backend: KeyringBackendName }
  | { kind: "plaintext"; reason: string };

/* ── injectable process runner (keeps the unix backends testable) ────────── */

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (bin: string, args: string[], input?: string) => RunResult;

const defaultRunner: CommandRunner = (bin, args, input) => {
  const res = spawnSync(bin, args, {
    input,
    encoding: "utf-8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (res.error) return { status: null, stdout: "", stderr: String(res.error.message ?? res.error) };
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

let runner: CommandRunner = defaultRunner;

/** Test-only: swap the process runner (pass `null` to restore the real one). */
export function __setCommandRunner(next: CommandRunner | null): void {
  runner = next ?? defaultRunner;
}

/* ── one-shot stderr warnings ────────────────────────────────────────────── */

const warned = new Set<string>();

/**
 * stderr, never stdout — a `--json` payload must stay parseable. One-shot per
 * message so a save that touches three profiles does not print the same
 * paragraph three times.
 */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** Test-only: clear the one-shot warning latch and the decrypt memo. */
export function resetSecretStoreState(): void {
  warned.clear();
  unprotectMemo.clear();
  libsecretAvailable = undefined;
}

/* ── backend preference ──────────────────────────────────────────────────── */

export class SecretBackendError extends Error {}

/**
 * The backend the NEXT write should use, and whether the user demanded it.
 * `forced` is what turns "fall back with a warning" into "fail loudly".
 */
export function backendPreference(env: NodeJS.ProcessEnv = process.env): {
  name: SecretBackendName;
  forced: boolean;
} {
  const raw = env.EVALGUARD_SECRET_BACKEND?.trim().toLowerCase();
  if (!raw || raw === "auto") return { name: platformDefaultBackend(), forced: false };
  if ((SECRET_BACKENDS as readonly string[]).includes(raw)) {
    return { name: raw as SecretBackendName, forced: true };
  }
  throw new SecretBackendError(
    `Unknown EVALGUARD_SECRET_BACKEND=${JSON.stringify(raw)}. ` +
      `Valid values: auto, ${SECRET_BACKENDS.join(", ")}.`,
  );
}

/**
 * Warn once about a malformed `EVALGUARD_SECRET_BACKEND` without resolving a
 * backend (so it costs no subprocess) and without throwing.
 *
 * Reads call this. `EVALGUARD_SECRET_BACKEND=plaintxt` otherwise means the user
 * believes they forced plaintext, gets the platform default instead, and only
 * discovers it on the next write. Writes still hard-fail via
 * {@link backendPreference}.
 */
export function warnOnInvalidBackendEnv(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.EVALGUARD_SECRET_BACKEND?.trim().toLowerCase();
  if (!raw || raw === "auto" || (SECRET_BACKENDS as readonly string[]).includes(raw)) return;
  warnOnce(
    `⚠ EvalGuard: ignoring unknown EVALGUARD_SECRET_BACKEND=${JSON.stringify(raw)}. ` +
      `Valid values: auto, ${SECRET_BACKENDS.join(", ")}.`,
  );
}

let libsecretAvailable: boolean | undefined;

/** Is `secret-tool` on PATH? Probed once per process. */
function hasSecretTool(): boolean {
  if (libsecretAvailable !== undefined) return libsecretAvailable;
  const res = runner("secret-tool", ["--version"]);
  libsecretAvailable = res.status === 0;
  return libsecretAvailable;
}

/**
 * The backend `auto` picks. Linux without libsecret resolves to `plaintext`
 * here rather than pretending — the caller then warns loudly exactly once.
 */
export function platformDefaultBackend(): SecretBackendName {
  if (process.platform === "win32") return "dpapi";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux" && hasSecretTool()) return "libsecret";
  return "plaintext";
}

/** One-line, user-facing description of a backend. Never oversells `plaintext`. */
export function describeBackend(name: SecretBackendName): string {
  switch (name) {
    case "dpapi":
      return "Windows DPAPI (CurrentUser scope)";
    case "keychain":
      return "macOS Keychain";
    case "libsecret":
      return "libsecret / Secret Service";
    case "plaintext":
      return "plaintext — NOT encrypted";
  }
}

/* ── envelope helpers ────────────────────────────────────────────────────── */

export function isProtectedSecret(value: unknown): value is ProtectedSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.backend === "string" &&
    (SECRET_BACKENDS as readonly string[]).includes(v.backend) &&
    v.backend !== "plaintext" &&
    typeof v.v === "number"
  );
}

/**
 * Stable, non-reversible account name for a (config file, profile) pair.
 *
 * Deterministic on purpose: re-saving a profile overwrites the same keyring
 * entry instead of littering the user's Keychain with one orphan per login.
 * It is a hash, so a keyring browser does not display the user's home path.
 */
export function keyringAccount(ref: SecretRef): string {
  const material = `${path.resolve(ref.configFile)}${ref.profile}`;
  return `eg-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/* ── DPAPI (Windows) ─────────────────────────────────────────────────────── */

/**
 * `System.Security` must be loaded explicitly under Windows PowerShell 5.1 —
 * `[Security.Cryptography.ProtectedData]` is not one of the auto-loaded types
 * (verified: without the Add-Type line the script dies with "Unable to find
 * type").
 *
 * The secret travels over STDIN, base64-encoded, never as an argv element:
 * command lines of a running process are readable by other processes on the
 * same box, so passing a key as an argument would leak it for the lifetime of
 * the spawn.
 *
 * `optionalEntropy` is deliberately $null. Any entropy we could pass would
 * have to be a constant compiled into this file, i.e. public — it would add no
 * secrecy, only an interop footgun. DPAPI's strength here is the user's master
 * key, which is not ours to supply.
 */
function dpapiScript(op: "Protect" | "Unprotect"): string {
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$in = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($in)",
    `$out = [Security.Cryptography.ProtectedData]::${op}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("\n");
}

/**
 * Absolute path to Windows PowerShell when we can build one.
 *
 * Resolving `powershell.exe` off PATH would let anything that can prepend a
 * directory to PATH hand us a different binary — and we are about to feed that
 * binary a plaintext API key on stdin.
 */
function powershellBinary(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (root) return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return "powershell.exe";
}

function runDpapi(op: "Protect" | "Unprotect", inputB64: string): string | null {
  const encoded = Buffer.from(dpapiScript(op), "utf16le").toString("base64");
  const res = runner(
    powershellBinary(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    inputB64,
  );
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

/* ── macOS Keychain ──────────────────────────────────────────────────────── */

function keychainStore(account: string, label: string, secret: string): boolean {
  // `-w` with no value makes `security` read the password from stdin instead
  // of taking it as an argv element (which every other process on the box can
  // read). It prompts for a confirmation copy, hence the value twice.
  // `-U` updates an existing item rather than failing with errSecDuplicateItem.
  const res = runner(
    "security",
    ["add-generic-password", "-U", "-s", SECRET_SERVICE, "-a", account, "-l", label, "-w"],
    `${secret}\n${secret}\n`,
  );
  return res.status === 0;
}

function keychainLookup(account: string): string | null {
  const res = runner("security", ["find-generic-password", "-s", SECRET_SERVICE, "-a", account, "-w"]);
  if (res.status !== 0) return null;
  const out = res.stdout.replace(/\r?\n$/, "");
  return out.length > 0 ? out : null;
}

function keychainDelete(account: string): void {
  runner("security", ["delete-generic-password", "-s", SECRET_SERVICE, "-a", account]);
}

/* ── Linux libsecret ─────────────────────────────────────────────────────── */

function libsecretStore(account: string, label: string, secret: string): boolean {
  // `secret-tool store` reads the secret from stdin, so it never appears in
  // the process's command line.
  const res = runner(
    "secret-tool",
    ["store", "--label", label, "service", SECRET_SERVICE, "account", account],
    `${secret}\n`,
  );
  return res.status === 0;
}

function libsecretLookup(account: string): string | null {
  const res = runner("secret-tool", ["lookup", "service", SECRET_SERVICE, "account", account]);
  if (res.status !== 0) return null;
  const out = res.stdout.replace(/\r?\n$/, "");
  return out.length > 0 ? out : null;
}

function libsecretDelete(account: string): void {
  runner("secret-tool", ["clear", "service", SECRET_SERVICE, "account", account]);
}

/* ── public API ──────────────────────────────────────────────────────────── */

/**
 * Protect `secret` for storage, or report — explicitly — that it could not be
 * protected and the caller must write it in the clear.
 *
 * Throws only when the user NAMED a backend that cannot be used: an explicit
 * `EVALGUARD_SECRET_BACKEND=keychain` that silently degraded to plaintext
 * would be exactly the lie this module exists to prevent.
 */
export function protectSecret(secret: string, ref: SecretRef): ProtectResult {
  const pref = backendPreference();

  if (pref.name === "plaintext") {
    return {
      kind: "plaintext",
      reason: pref.forced
        ? "EVALGUARD_SECRET_BACKEND=plaintext"
        : `no OS credential store available on ${process.platform}`,
    };
  }

  const backend = pref.name;
  const account = keyringAccount(ref);
  const label = `EvalGuard CLI (${ref.profile})`;
  let ok = false;

  if (backend === "dpapi") {
    const ciphertext = runDpapi("Protect", Buffer.from(secret, "utf-8").toString("base64"));
    if (ciphertext) {
      return { kind: "protected", backend, secret: { v: PROTECTED_SECRET_VERSION, backend, ciphertext } };
    }
  } else if (backend === "keychain") {
    ok = keychainStore(account, label, secret);
  } else {
    ok = libsecretStore(account, label, secret);
  }

  if (ok) {
    return { kind: "protected", backend, secret: { v: PROTECTED_SECRET_VERSION, backend, ref: account } };
  }

  const detail = `${describeBackend(backend)} is unavailable or failed`;
  if (pref.forced) {
    throw new SecretBackendError(
      `EVALGUARD_SECRET_BACKEND=${backend} was requested but ${detail}. ` +
        `Refusing to silently store the API key in plaintext. ` +
        `Fix the credential store, or set EVALGUARD_SECRET_BACKEND=plaintext to accept an ` +
        `unencrypted key on disk, or use EVALGUARD_API_KEY so nothing is written at all.`,
    );
  }
  return { kind: "plaintext", reason: detail };
}

const unprotectMemo = new Map<string, string | undefined>();

/**
 * Recover a protected secret. Returns `undefined` (never throws) when the
 * envelope cannot be unwrapped — a DPAPI blob copied from another machine or
 * user, a Keychain entry the user deleted — after saying so on stderr, so the
 * failure reads as "re-run login", not as a crash.
 */
export function unprotectSecret(envelope: ProtectedSecret): string | undefined {
  const memoKey = `${envelope.backend}:${envelope.ciphertext ?? ""}:${envelope.ref ?? ""}`;
  if (unprotectMemo.has(memoKey)) return unprotectMemo.get(memoKey);

  let value: string | undefined;
  if (envelope.v !== PROTECTED_SECRET_VERSION) {
    warnOnce(
      `Warning: stored credential uses envelope version ${envelope.v}, this CLI understands ` +
        `${PROTECTED_SECRET_VERSION}. Upgrade @evalguard/cli, or re-run \`evalguard login\`.`,
    );
  } else if (envelope.backend === "dpapi") {
    const out = envelope.ciphertext ? runDpapi("Unprotect", envelope.ciphertext) : null;
    value = out ? Buffer.from(out, "base64").toString("utf-8") : undefined;
  } else if (envelope.ref) {
    const out = envelope.backend === "keychain" ? keychainLookup(envelope.ref) : libsecretLookup(envelope.ref);
    value = out ?? undefined;
  }

  if (value === undefined && envelope.v === PROTECTED_SECRET_VERSION) {
    warnOnce(
      `Warning: could not read the stored API key from ${describeBackend(envelope.backend)}. ` +
        (envelope.backend === "dpapi"
          ? "A DPAPI blob can only be decrypted by the same Windows user on the same machine. "
          : "The keyring entry may have been removed, or the keyring may be locked. ") +
        "Re-run `evalguard login --key <key>`, or set EVALGUARD_API_KEY.",
    );
  }

  unprotectMemo.set(memoKey, value);
  return value;
}

/**
 * Best-effort removal of the OS-side copy when a profile is deleted, so
 * `evalguard profile delete` does not leave an entry behind in the user's
 * Keychain. DPAPI has nothing to purge — its ciphertext lives in the file that
 * is being rewritten.
 */
export function purgeSecret(envelope: ProtectedSecret): void {
  try {
    if (!envelope.ref) return;
    if (envelope.backend === "keychain") keychainDelete(envelope.ref);
    else if (envelope.backend === "libsecret") libsecretDelete(envelope.ref);
  } catch {
    // Never let credential-store housekeeping fail a config write.
  }
}
