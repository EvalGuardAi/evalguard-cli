// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyManagedBlock, stripManagedBlock, HANDLERS } from "../commands/setup";

describe("applyManagedBlock — first install", () => {
  it("creates the block in an empty file", () => {
    const result = applyManagedBlock("", "Hello world");
    expect(result).toContain("evalguard-setup-managed-block-start");
    expect(result).toContain("evalguard-setup-managed-block-end");
    expect(result).toContain("Hello world");
  });

  it("appends the block to a file with existing content", () => {
    const existing = "# Project notes\n\nSome unrelated stuff.\n";
    const result = applyManagedBlock(existing, "EvalGuard guidance");
    expect(result.startsWith("# Project notes")).toBe(true);
    expect(result).toContain("Some unrelated stuff.");
    expect(result).toContain("EvalGuard guidance");
    expect(result.indexOf("EvalGuard guidance")).toBeGreaterThan(result.indexOf("unrelated"));
  });

  it("preserves a single trailing newline", () => {
    const result = applyManagedBlock("Foo\n", "Bar");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.match(/\n+$/)?.[0].length ?? 0).toBe(1);
  });
});

describe("applyManagedBlock — re-install (idempotent)", () => {
  it("replaces the existing block, doesn't duplicate", () => {
    const after1 = applyManagedBlock("", "Version 1");
    const after2 = applyManagedBlock(after1, "Version 2");
    expect(after2).toContain("Version 2");
    expect(after2).not.toContain("Version 1");
    // Only one start sentinel in result
    const startCount = (after2.match(/evalguard-setup-managed-block-start/g) ?? []).length;
    expect(startCount).toBe(1);
  });

  it("preserves user content before and after the block on replacement", () => {
    const initial = "Header\n";
    const afterInstall = applyManagedBlock(initial, "First version");
    const withFooter = afterInstall + "\nUser-added footer\n";
    const replaced = applyManagedBlock(withFooter, "Second version");
    expect(replaced.startsWith("Header")).toBe(true);
    expect(replaced).toContain("Second version");
    expect(replaced).toContain("User-added footer");
    expect(replaced).not.toContain("First version");
  });
});

describe("stripManagedBlock", () => {
  it("returns input unchanged when no block exists", () => {
    const input = "Just user content.\n";
    expect(stripManagedBlock(input)).toBe(input);
  });

  it("removes the block + sentinels, preserves surrounding content", () => {
    const before = "User header\n";
    const after = "\nUser footer\n";
    const withBlock = applyManagedBlock(before, "Managed content") + after;
    const stripped = stripManagedBlock(withBlock);
    expect(stripped).toContain("User header");
    expect(stripped).toContain("User footer");
    expect(stripped).not.toContain("Managed content");
    expect(stripped).not.toContain("evalguard-setup-managed-block");
  });

  it("returns empty-ish content when the block was the entire file", () => {
    const withBlock = applyManagedBlock("", "Only block");
    const stripped = stripManagedBlock(withBlock);
    expect(stripped.trim()).toBe("");
  });

  it("idempotent — second strip is a no-op", () => {
    const withBlock = applyManagedBlock("foo\n", "bar");
    const stripOnce = stripManagedBlock(withBlock);
    const stripTwice = stripManagedBlock(stripOnce);
    expect(stripTwice).toBe(stripOnce);
  });
});

describe("Cursor handler — MDC vs legacy format detection", () => {
  let tmpDir: string;
  let originalCwd: string;
  const cursor = HANDLERS.find((h) => h.id === "cursor")!;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evalguard-setup-test-"));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes MDC file when .cursor/rules/ directory exists (Cursor 0.45+)", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "rules"), { recursive: true });

    const written = cursor.install({ apiKey: null, dryRun: false });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/[\\\/]\.cursor[\\\/]rules[\\\/]evalguard\.mdc$/);

    const content = fs.readFileSync(written[0], "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("description: EvalGuard guardrails");
    expect(content).toContain("globs:");
    expect(content).toContain("alwaysApply: false");
    expect(content).toContain("EvalGuard guardrails");
    expect(content).toContain("EvalGuard gateway");
  });

  it("writes MDC file when .cursor/ exists (even without rules subdir — newer Cursor)", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });

    const written = cursor.install({ apiKey: null, dryRun: false });

    expect(written[0]).toMatch(/evalguard\.mdc$/);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "evalguard.mdc"))).toBe(true);
  });

  it("falls back to .cursorrules legacy format when no .cursor/ dir", () => {
    // No .cursor dir; just a stray .cursorrules to satisfy `detect()`
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "# user content\n");

    const written = cursor.install({ apiKey: null, dryRun: false });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/[\\\/]\.cursorrules$/);

    const content = fs.readFileSync(written[0], "utf8");
    expect(content).toContain("# user content");
    expect(content).toContain("evalguard-setup-managed-block-start");
    expect(content).toContain("EvalGuard guardrails");
  });

  it("MDC re-install replaces (not duplicates) the file", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "rules"), { recursive: true });

    cursor.install({ apiKey: null, dryRun: false });
    const sizeOnce = fs.statSync(path.join(tmpDir, ".cursor", "rules", "evalguard.mdc")).size;

    cursor.install({ apiKey: null, dryRun: false });
    const sizeTwice = fs.statSync(path.join(tmpDir, ".cursor", "rules", "evalguard.mdc")).size;

    expect(sizeTwice).toBe(sizeOnce);
  });

  it("uninstall removes MDC file", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "rules"), { recursive: true });
    cursor.install({ apiKey: null, dryRun: false });

    const removed = cursor.uninstall({ dryRun: false });

    expect(removed.some((p) => p.endsWith("evalguard.mdc"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "evalguard.mdc"))).toBe(false);
  });

  it("uninstall strips managed block from legacy .cursorrules", () => {
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "# user content\n");
    cursor.install({ apiKey: null, dryRun: false });
    expect(fs.readFileSync(path.join(tmpDir, ".cursorrules"), "utf8")).toContain("evalguard-setup-managed-block");

    cursor.uninstall({ dryRun: false });

    const after = fs.readFileSync(path.join(tmpDir, ".cursorrules"), "utf8");
    expect(after).toContain("# user content");
    expect(after).not.toContain("evalguard-setup-managed-block");
  });

  it("uninstall handles both MDC + legacy when both exist (mixed setup)", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "# legacy\n");

    // Install: writes MDC because .cursor/ exists
    cursor.install({ apiKey: null, dryRun: false });
    // Manually write legacy block too (simulating earlier install before MDC support)
    const legacyContent = applyManagedBlock("# legacy\n", "old block");
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), legacyContent);

    const removed = cursor.uninstall({ dryRun: false });

    expect(removed.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "evalguard.mdc"))).toBe(false);
    const legacyAfter = fs.readFileSync(path.join(tmpDir, ".cursorrules"), "utf8");
    expect(legacyAfter).toContain("# legacy");
    expect(legacyAfter).not.toContain("evalguard-setup-managed-block");
  });

  it("dry-run on MDC doesn't create the file", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "rules"), { recursive: true });

    const written = cursor.install({ apiKey: null, dryRun: true });

    expect(written[0]).toMatch(/evalguard\.mdc$/);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "evalguard.mdc"))).toBe(false);
  });
});

describe("applyManagedBlock — content escaping", () => {
  it("doesn't break on multi-line block content", () => {
    const block = "Line one\n  Line two indented\n\nLine four after blank";
    const result = applyManagedBlock("", block);
    expect(result).toContain("Line one");
    expect(result).toContain("  Line two indented");
    expect(result).toContain("Line four after blank");
  });

  it("trims leading/trailing whitespace from the block payload", () => {
    const result = applyManagedBlock("", "\n\n  Padded\n\n");
    // Padding should be normalised inside the sentinel pair
    expect(result).toContain("Padded");
    // No four-blank-line stretches
    expect(result).not.toMatch(/\n\n\n\n/);
  });

  it("handles content containing the sentinel-similar strings safely", () => {
    // User content might mention "managed-block" — must not confuse the parser.
    const userContent = "# Note: this is NOT a managed-block, just a name.\n";
    const result1 = applyManagedBlock(userContent, "First");
    const stripped = stripManagedBlock(result1);
    expect(stripped).toContain("# Note: this is NOT a managed-block");
    expect(stripped).not.toContain("First");
  });
});
