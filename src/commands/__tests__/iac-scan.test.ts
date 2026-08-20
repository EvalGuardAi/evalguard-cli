import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { executeIacScan } from "../iac-scan.js";

/* executeIacScan is the pure executor the .action() wrapper calls — testing it
 * directly avoids the process.exit hijack that races commander's promise
 * runner. The first invocation cold-imports @evalguard/core (large); that cost
 * is now paid in this file's import phase (below) rather than absorbed by a
 * per-test timeout, which is a budget it can outgrow at any load. */
// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("executeIacScan — directory walk + AI-infra rules", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalguard-iac-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("walks a dir, scans manifests, and gates on critical", async () => {
    fs.writeFileSync(
      path.join(tmpRoot, "Dockerfile"),
      "FROM vllm/vllm-openai\nENV OPENAI_API_KEY=sk-abcdEFGH1234567890ijklMNOP\nEXPOSE 8000\n",
    );
    fs.mkdirSync(path.join(tmpRoot, "k8s"));
    fs.writeFileSync(
      path.join(tmpRoot, "k8s", "mlflow.yaml"),
      "kind: Deployment\nspec:\n  containers:\n    - name: mlflow\n      ports:\n        - containerPort: 5000\n",
    );
    // A non-IaC file that must be ignored by the walk.
    fs.writeFileSync(path.join(tmpRoot, "README.md"), "0.0.0.0 mlflow vllm 8888");

    const result = await executeIacScan({ targetAbs: tmpRoot, failOn: "critical", maxBytes: 1_000_000 });
    expect(result.scannedFiles).toBe(2); // README.md skipped
    const ruleIds = result.findings.map((f) => f.ruleId);
    expect(ruleIds).toContain("iac-hardcoded-secret-openai");
    expect(ruleIds).toContain("iac-exposed-ai-service-port");
    expect(result.bySeverity.critical).toBeGreaterThanOrEqual(1);
    expect(result.flagged).toBeGreaterThanOrEqual(1);
    expect(result.exitCode).toBe(1);
  });

  it("excludes node_modules / .git from the walk", async () => {
    fs.mkdirSync(path.join(tmpRoot, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "node_modules", "pkg", "Dockerfile"),
      "FROM x\nENV AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP\n",
    );
    const result = await executeIacScan({ targetAbs: tmpRoot, failOn: "high", maxBytes: 1_000_000 });
    expect(result.scannedFiles).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("scans a single file passed directly (any extension)", async () => {
    const p = path.join(tmpRoot, "my-deploy");
    fs.writeFileSync(p, 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  ports:\n    - containerPort: 8888\n');
    const result = await executeIacScan({ targetAbs: p, failOn: "high", maxBytes: 1_000_000 });
    expect(result.scannedFiles).toBe(1);
    expect(result.findings.some((f) => f.ruleId === "iac-exposed-ai-service-port")).toBe(true);
  });

  it("clean repo gates pass (exit 0)", async () => {
    fs.writeFileSync(path.join(tmpRoot, "Dockerfile"), 'FROM python:3.12-slim\nCMD ["uvicorn","app","--host","127.0.0.1"]\n');
    const result = await executeIacScan({ targetAbs: tmpRoot, failOn: "low", maxBytes: 1_000_000 });
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
