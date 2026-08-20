/**
 * SHIPPED-SURFACE GATE — the built `dist/` must still contain the credential
 * protection, and it must still be WIRED into the code path `evalguard login`
 * actually runs.
 *
 * ── The incident this closes ───────────────────────────────────────────────
 *
 * `@evalguard/cli@3.7.4` is live on npm. Its `dist/` contains NO
 * `lib/secret-store.js`, NO `commands/profile.js`, and no DPAPI anywhere.
 * Running the published binary:
 *
 *     $ node bin/evalguard.js login --key eg_… --url http://127.0.0.1:9/api/v1
 *     ✓ Authenticated successfully.
 *     $ cat ~/.evalguard/config.json
 *     { "apiKey": "eg_FAKEKEY_local_build_test_1234567890", … }
 *
 * — the API key, verbatim, on disk. The REPO at that same version 3.7.4 emits
 * 8 additional modules and writes an `apiKeyEnc` DPAPI envelope instead.
 * Published bytes != repo at the same version.
 *
 * Root cause was chronology, not a broken pipeline: 3.7.4 was published at
 * 2026-08-05T18:00:50Z, and the secret store landed 65 minutes LATER
 * (21899510a) and again the next day (0d7b05ed8) — into a version number that
 * was already immutable on the registry. Nothing was watching the shipped
 * artifact, so the divergence was silent.
 *
 * ── Why the existing suite did not catch it ───────────────────────────────
 *
 * `src/lib/__tests__/secret-store.test.ts` is thorough (748 lines) but it
 * imports from `src/`. Every one of its assertions passes on a build that
 * emits none of these files, because it never looks at `dist/` — the only
 * thing a user receives. This gate looks at nothing else.
 *
 * ── Requires a build ───────────────────────────────────────────────────────
 *
 * Deliberately NOT skipped when `dist/` is missing. A gate that quietly opts
 * out when the artifact is absent is a gate that reports green for the exact
 * condition it exists to detect. Run `pnpm --filter @evalguard/cli build`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const DIST = resolve(__dirname, "..", "..", "dist");

/** Read a built artifact, failing with the build command rather than ENOENT. */
function dist(relPath: string): string {
  const full = join(DIST, relPath);
  if (!existsSync(full)) {
    throw new Error(
      `Shipped artifact missing: dist/${relPath}\n` +
        `This gate inspects the BUILT output, which is what npm publishes.\n` +
        `Build it first:  pnpm --filter @evalguard/cli build`,
    );
  }
  return readFileSync(full, "utf8");
}

describe("dist/ carries the credential-protection surface", () => {
  it("emits the secret store and the profile command", () => {
    // The eight modules published 3.7.4 is missing. `.d.ts` included: a
    // consumer doing `import type` gets a broken package without them.
    for (const f of [
      "lib/secret-store.js",
      "lib/secret-store.d.ts",
      "commands/profile.js",
      "commands/profile.d.ts",
    ]) {
      expect(existsSync(join(DIST, f)), `dist/${f} is missing`).toBe(true);
    }
  });

  it("implements every credential backend, DPAPI included", () => {
    const store = dist("lib/secret-store.js");
    for (const backend of ["dpapi", "keychain", "libsecret", "plaintext"]) {
      expect(store, `backend "${backend}" absent from dist`).toContain(backend);
    }
    // The Windows path must be real DPAPI, not an obfuscation stand-in.
    expect(store).toContain("ProtectedData");
    expect(store).toContain("CurrentUser");
    // macOS / Linux credential stores.
    expect(store).toContain("add-generic-password");
    expect(store).toContain("secret-tool");
  });

  it("wires the secret store into the shipped login path, not just onto disk", () => {
    // A module can exist in dist and still be dead code — the failure mode
    // where a guard ships but never runs. Assert the imports.
    expect(dist("index.js")).toMatch(/from ["']\.\/lib\/secret-store\.js["']/);
    expect(dist("lib/config.js")).toMatch(/from ["']\.\/secret-store\.js["']/);
  });

  it("removes the plaintext key when it protects one", () => {
    const config = dist("lib/config.js");
    expect(config).toContain("protectSecret(");
    expect(config).toContain("apiKeyEnc");
    // The write path must route through protection before touching the fs.
    expect(config).toContain("protectProfileSecrets");
    // …and drop the cleartext copy, rather than storing both.
    expect(config).toMatch(/delete\s+next\.apiKey\s*;/);
  });
});

describe("the built CLI does not write a cleartext API key", () => {
  // The literal secret is what we hunt for in the bytes on disk.
  const SECRET = "eg_dist_gate_plaintext_probe_9f3a2c";
  let tmp: string;
  let file: string;
  let warnings: string[];
  let branch: "protected" | "plaintext";
  /** Can a credential store actually protect a secret on THIS host? */
  let hostCanProtect: boolean;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "eg-dist-gate-"));
    file = join(tmp, "config.json");
    warnings = [];

    // Import the BUILT modules — the same bytes `npm pack` puts in the tarball.
    const store = await import(pathToFileURL(join(DIST, "lib", "secret-store.js")).href);
    const cfg = await import(pathToFileURL(join(DIST, "lib", "config.js")).href);

    store.resetSecretStoreState();

    // Establish the host's capability INDEPENDENTLY of the write path, so a
    // downgrade cannot excuse itself by warning. If the store can protect a
    // secret here, saveConfigFile has no licence to write cleartext.
    const probe = store.protectSecret(SECRET, { configFile: file, profile: "__probe__" });
    hostCanProtect = probe.kind === "protected";
    // keychain/libsecret genuinely write to the OS store — don't leave litter.
    if (hostCanProtect) store.purgeSecret(probe.secret);
    store.resetSecretStoreState();
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      warnings.push(String(chunk));
      return realWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;
    // secret-store warns via console.warn (stderr, so `--json` stays
    // parseable). Capture warn AND error so the assertion cannot pass simply
    // because the message moved channels.
    const realError = console.error;
    const realWarn = console.warn;
    const capture = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    console.error = capture;
    console.warn = capture;

    try {
      cfg.saveConfigFile(
        {
          version: 2,
          currentProfile: "default",
          profiles: { default: { apiKey: SECRET, baseUrl: "https://evalguard.ai/api/v1" } },
        },
        file,
      );
    } finally {
      process.stderr.write = realWrite;
      console.error = realError;
      console.warn = realWarn;
    }

    const written = JSON.parse(readFileSync(file, "utf8"));
    branch = written.profiles?.default?.apiKeyEnc ? "protected" : "plaintext";
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("either encrypts the key, or says loudly that it did not", () => {
    const raw = readFileSync(file, "utf8");
    const written = JSON.parse(raw);
    const profile = written.profiles.default;

    if (branch === "protected") {
      // A credential store was available. The secret must be GONE from the
      // file — this is the assertion published 3.7.4 fails.
      expect(raw).not.toContain(SECRET);
      expect(profile.apiKey).toBeUndefined();
      // The back-compat mirror must not re-leak it at the top level either.
      expect(written.apiKey).toBeUndefined();
      expect(profile.apiKeyEnc.backend).toBeTruthy();
      expect(String(profile.apiKeyEnc.ciphertext ?? profile.apiKeyEnc.account)).not.toContain(
        SECRET,
      );
    } else {
      // No credential store on this host. Plaintext is permitted ONLY when the
      // user is told, on stderr, in as many words. A silent downgrade is the
      // thing being prevented, so the warning is a hard assertion.
      expect(profile.apiKey).toBe(SECRET);
      expect(warnings.join("\n")).toMatch(/PLAINTEXT|UNENCRYPTED/i);
    }
  });

  it("never falls back to cleartext on a host that CAN protect", () => {
    // Closes the mutant that keeps every file in place but stops calling the
    // store: warning loudly is not a licence to write the key in the clear
    // when the platform's credential store is right there and working.
    if (hostCanProtect) {
      expect(branch).toBe("protected");
      expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    } else {
      expect(branch).toBe("plaintext");
    }
  });

  it("records which branch this host exercised", () => {
    // Not a tautology: `branch` is only assigned if saveConfigFile completed,
    // which requires dist/lib/secret-store.js to have loaded at import time.
    expect(["protected", "plaintext"]).toContain(branch);
  });
});
