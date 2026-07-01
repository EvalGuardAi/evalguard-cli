import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installPreCommitHook } from "../secret-scan.js";

// Competitive-audit gap (vs varlock/superagent `scan --install-hook`): expose the
// pre-commit secret gate EvalGuard uses internally to customers.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-hook-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("installPreCommitHook", () => {
  it("writes a husky pre-commit when .husky exists (no shebang)", () => {
    fs.mkdirSync(path.join(dir, ".husky"));
    installPreCommitHook(dir);
    const hook = path.join(dir, ".husky", "pre-commit");
    expect(fs.existsSync(hook)).toBe(true);
    const body = fs.readFileSync(hook, "utf-8");
    expect(body).toContain("secret-scan --staged --fail-on-secret");
    expect(body.startsWith("#!/bin/sh")).toBe(false); // husky v9 = plain script
  });

  it("writes an executable .git/hooks/pre-commit with a shebang when no husky", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    installPreCommitHook(dir);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    expect(fs.existsSync(hook)).toBe(true);
    const body = fs.readFileSync(hook, "utf-8");
    expect(body.startsWith("#!/bin/sh")).toBe(true);
    expect(body).toContain("secret-scan --staged --fail-on-secret");
    // executable bit (skip the assert on platforms without POSIX mode)
    if (process.platform !== "win32") {
      expect(fs.statSync(hook).mode & 0o111).toBeGreaterThan(0);
    }
  });

  it("is idempotent — running twice does not duplicate the command", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    installPreCommitHook(dir);
    installPreCommitHook(dir);
    const body = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(body.match(/secret-scan --staged/g)!.length).toBe(1);
  });

  it("appends to an existing pre-commit instead of clobbering it", () => {
    const hooks = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nnpm run lint\n");
    installPreCommitHook(dir);
    const body = fs.readFileSync(path.join(hooks, "pre-commit"), "utf-8");
    expect(body).toContain("npm run lint"); // preserved
    expect(body).toContain("secret-scan --staged"); // appended
  });
});
