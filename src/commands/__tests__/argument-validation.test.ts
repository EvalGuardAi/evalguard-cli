import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerServerRead } from "../server-read.js";
import { registerCostExport } from "../cost-export.js";
import { registerModeration } from "../moderation.js";
import { registerLogs } from "../logs.js";
import { registerBudget } from "../budget.js";
import { registerVulnLookup } from "../vuln-lookup.js";
import { registerDecisionBom } from "../decision-bom.js";
import { resetResolvedProjectId } from "../../lib/config.js";

/**
 * ARGUMENT-VALIDATION REGRESSION — the 22 defects measured on 3.8.0.
 *
 * Every case here was RED against the SHIPPED bytes (apps/cli/dist, built from
 * the commit before this one) and driven through a local stub API. The recorded
 * before/after, abbreviated:
 *
 *   runs --project ""                     EXIT 0, 2 requests → the DEFAULT
 *                                         project's runs   ⇒ EXIT 2, 0 requests
 *   cost-export --start not-a-date        EXIT 0, "✓ Wrote 62 bytes"
 *                                                          ⇒ EXIT 2, no file
 *   cost-export --start 08-09 --end 08-01 EXIT 0, "✓ Wrote 68 bytes"
 *                                                          ⇒ EXIT 2, no file
 *   cost-export --currency NOTACURRENCY   EXIT 0, "✓ Wrote 65 bytes"
 *                                                          ⇒ EXIT 2, no file
 *   moderation image --threshold abc      EXIT 0, "clean (1.0%)"  ⇒ EXIT 2
 *   moderation image --threshold 5        EXIT 0, "clean (1.0%)"  ⇒ EXIT 2
 *   moderation image --url "not a url"    EXIT 0, "clean (1.0%)"  ⇒ EXIT 2
 *   scans/traces/prompts/webhooks -n abc  EXIT 0, default page    ⇒ EXIT 2
 *   logs list --since 09 --until 01       EXIT 0, "No logs match" ⇒ EXIT 2
 *   runs get not-a-uuid                   EXIT 0, rendered a run  ⇒ EXIT 2
 *   budget get not-a-uuid                 EXIT 1, raw TypeError   ⇒ EXIT 2
 *   vuln-lookup not-a-purl                EXIT 1, "entries is not iterable"
 *                                                                 ⇒ EXIT 2
 *
 * THE ASSERTION THAT MATTERS MOST is not the exit code — it is
 * `expect(fetchSpy).not.toHaveBeenCalled()`. A refusal that still issues the
 * request has not refused anything; for `cost-export` it would still have
 * written the file. And every refusal case is followed by its POSITIVE
 * CONTROL: the valid form of the same argument, asserted to reach the network
 * with the value intact. An over-strict validator passes every test above and
 * is a worse defect than the one being fixed.
 */

const PROJECT = "00000000-0000-4000-8000-0000000000a2";
const ORG = "11111111-1111-4111-8111-111111111111";
const UUID = "44444444-4444-4444-8444-444444444444";

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let fetchSpy: ReturnType<typeof vi.fn>;
let tmpDir: string;
let stdout: string[];
let stderr: string[];

/** Canned answers keyed by URL fragment, so a control case gets a real render. */
function stubBody(url: string): { body: unknown; contentType?: string; headers?: Record<string, string> } {
  if (url.includes("/project/current")) return { body: { projectId: "DEFAULT-PROJECT" } };
  if (url.includes("/cost/export"))
    return {
      body: "BillingCurrency,BilledCost\nEUR,1.00\n",
      contentType: "text/csv",
      headers: { "x-evalguard-export-format": "focus" },
    };
  if (url.includes("/moderation/image"))
    return { body: { success: true, data: { flagged: false, score: 0.01, provider: "stub" } } };
  if (url.includes("/webhooks/deliveries"))
    return { body: { success: true, data: { deliveries: [], total: 0 } } };
  if (url.includes("/supply-chain/lookup"))
    return {
      body: {
        success: true,
        data: {
          entries: [],
          summary: { total: 0, queried: 0, unsupported: 0, invalid: 0, vulnerable: 0, vulnerabilitiesFound: 0 },
          truncatedAdvisoryCount: 0,
        },
      },
    };
  if (url.includes("/traces?")) return { body: { success: true, data: { traces: [] } } };
  // `logs list` reads production logs through GET /monitoring. It used to call
  // GET /logs, a path apps/web never implemented (404 via api/v1/[...catch]);
  // this stub answered it anyway, which is precisely why a suite driving a stub
  // cannot notice that nothing is listening.
  if (url.includes("/monitoring?")) return { body: { success: true, data: { recentLogs: [] } } };
  if (/\/evals\/[^?]+/.test(url)) return { body: { success: true, data: { id: UUID, status: "passed" } } };
  if (url.includes("/budget"))
    return {
      body: {
        success: true,
        // Deliberately WITHOUT remainingUsd / percentUsed — the crash-shaped gap.
        data: { keyId: UUID, monthlyBudgetUsd: 100, currentPeriodSpentUsd: 1.5, currentPeriodStartedAt: "2026-08-01" },
      },
    };
  return { body: { success: true, data: [] } };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-argval-"));
  stdout = [];
  stderr = [];
  resetResolvedProjectId();

  // NEVER let a test read the operator's real ~/.evalguard/config.json.
  process.env.EVALGUARD_CONFIG_FILE = path.join(tmpDir, "config.json");
  process.env.EVALGUARD_API_KEY = "eg_test_key";
  process.env.EVALGUARD_BASE_URL = "https://stub.test/api/v1";

  fetchSpy = vi.fn(async (input: unknown) => {
    const url = String(input);
    const { body, contentType, headers } = stubBody(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": contentType ?? "application/json", ...(headers ?? {}) },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.EVALGUARD_CONFIG_FILE;
  delete process.env.EVALGUARD_API_KEY;
  delete process.env.EVALGUARD_BASE_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a fresh program, run it, and report the exit code (0 = no exit call). */
async function run(argv: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  registerServerRead(program);
  registerCostExport(program);
  registerModeration(program);
  registerLogs(program);
  registerBudget(program);
  registerVulnLookup(program);
  registerDecisionBom(program);
  try {
    await program.parseAsync(["node", "evalguard", ...argv]);
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  }
  return 0;
}

/** Assert: refused with exit 2, and NOTHING left the process. */
async function expectRefusal(argv: string[], messageFragment: RegExp): Promise<void> {
  const code = await run(argv);
  expect(code, `expected a refusal for: ${argv.join(" ")}`).toBe(2);
  expect(stderr.join("\n")).toMatch(messageFragment);
  // The load-bearing half: a refusal that still issued the request has not
  // refused anything.
  expect(fetchSpy, "a refusal must not touch the network").not.toHaveBeenCalled();
}

// ─────────────────────────────────────────────────────────────────────────────
// H1 — `runs --project ""` printed ANOTHER project's runs
// ─────────────────────────────────────────────────────────────────────────────

describe("H1 :: an empty --project is a caller error, not 'unspecified'", () => {
  it("refuses `runs --project \"\"` before resolving anything", async () => {
    await expectRefusal(["runs", "--project", ""], /Invalid --project/);
  });

  it.each([
    ["scans", ["scans", "--project", ""]],
    ["traces", ["traces", "--project", ""]],
    ["prompts", ["prompts", "--project", ""]],
    ["traces get", ["traces", "get", UUID, "--project", ""]],
    ["prompts get", ["prompts", "get", "n", "--project", ""]],
    ["logs list", ["logs", "list", "--project", ""]],
    ["cost-export", ["cost-export", ORG, "--project", ""]],
  ])("refuses it on `%s` too — one fixed sibling is not a fix", async (_name, argv) => {
    await expectRefusal(argv, /Invalid --project/);
  });

  it("POSITIVE CONTROL: `traces get --project <id>` actually USES that project", async () => {
    // 24th defect, found by the empty-string test above failing on this
    // subcommand: the parent `traces` command swallowed `--project`, the child
    // saw `undefined`, and the CLI silently looked the trace up in the org's
    // DEFAULT project. A caller who did everything right got another project's
    // scope. This asserts the id reaches the query string.
    expect(await run(["traces", "get", UUID, "--project", PROJECT])).toBe(0);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`projectId=${PROJECT}`))).toBe(true);
    expect(urls.some((u) => u.includes("/project/current"))).toBe(false);
  });

  it("POSITIVE CONTROL: `prompts get --project <id>` actually USES that project", async () => {
    expect(await run(["prompts", "get", "my-prompt", "--project", PROJECT])).toBe(0);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`projectId=${PROJECT}`))).toBe(true);
    expect(urls.some((u) => u.includes("/project/current"))).toBe(false);
  });

  it("POSITIVE CONTROL: an explicit project id still queries exactly that project", async () => {
    expect(await run(["runs", "--project", PROJECT])).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`projectId=${PROJECT}`);
    // and it did NOT go and ask the server what the default project is
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain("/project/current");
  });

  it("POSITIVE CONTROL: OMITTING --project still auto-resolves the default project", async () => {
    // The behaviour `--project ""` was silently borrowing must remain
    // available to the people who actually asked for it.
    expect(await run(["runs"])).toBe(0);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/project/current"))).toBe(true);
    expect(urls.some((u) => u.includes("projectId=DEFAULT-PROJECT"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H2 — cost-export wrote a FinOps artifact for a period/currency nobody asked for
// ─────────────────────────────────────────────────────────────────────────────

describe("H2 :: cost-export refuses before it writes a FinOps artifact", () => {
  it("refuses an unparseable --start", async () => {
    await expectRefusal(["cost-export", ORG, "--start", "not-a-date"], /Invalid --start/);
  });

  it("refuses an unparseable --end", async () => {
    await expectRefusal(["cost-export", ORG, "--end", "whenever"], /Invalid --end/);
  });

  it("refuses an INVERTED range (the server silently swaps it)", async () => {
    await expectRefusal(
      ["cost-export", ORG, "--start", "2026-08-09", "--end", "2026-08-01"],
      /Invalid range: --start .* is after --end/,
    );
  });

  it("refuses a --currency the server would silently replace with USD", async () => {
    await expectRefusal(["cost-export", ORG, "--currency", "NOTACURRENCY"], /Invalid --currency/);
  });

  it("writes NO FILE when it refuses — the artifact is the whole point", async () => {
    const out = path.join(tmpDir, "cost.csv");
    const code = await run(["cost-export", ORG, "--start", "not-a-date", "-o", out]);
    expect(code).toBe(2);
    expect(fs.existsSync(out), "a refused export must not leave a file behind").toBe(false);
  });

  it("POSITIVE CONTROL: a valid period + currency reaches the server and writes the file", async () => {
    const out = path.join(tmpDir, "ok.csv");
    const code = await run([
      "cost-export", ORG,
      "--start", "2026-08-01",
      "--end", "2026-08-09",
      "--currency", "eur",
      "-o", out,
    ]);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    // The NORMALIZED values the validator produced are what went on the wire.
    expect(url.searchParams.get("startDate")).toBe("2026-08-01T00:00:00.000Z");
    expect(url.searchParams.get("endDate")).toBe("2026-08-09T00:00:00.000Z");
    expect(url.searchParams.get("currency")).toBe("EUR");
    expect(fs.existsSync(out)).toBe(true);
  });

  it("POSITIVE CONTROL: omitting the period flags still exports (server defaults apply)", async () => {
    expect(await run(["cost-export", ORG])).toBe(0);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get("startDate")).toBeNull();
    expect(url.searchParams.get("endDate")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H3 — moderation printed `clean (1.0%)` under a gate that never ran
// ─────────────────────────────────────────────────────────────────────────────

describe("H3 :: moderation refuses a threshold that would not be the gate it claims", () => {
  const IMG = ["moderation", "image", "--org", ORG, "--project", PROJECT, "--url", "https://e.test/a.png"];

  it("refuses --threshold abc (was: dropped at the wire, server default ran)", async () => {
    await expectRefusal([...IMG, "--threshold", "abc"], /Invalid --threshold/);
  });

  it("refuses --threshold 5 (was: forwarded, and unreachable by a 0..1 score)", async () => {
    await expectRefusal([...IMG, "--threshold", "5"], /outside the valid range 0-1/);
  });

  it("refuses --url 'not a url'", async () => {
    await expectRefusal(
      ["moderation", "image", "--org", ORG, "--project", PROJECT, "--url", "not a url"],
      /Invalid --url/,
    );
  });

  it.each([
    ["video", ["moderation", "video", "--org", ORG, "--project", PROJECT, "--frame", "https://e.test/1.png", "--threshold", "abc"]],
    ["deepfake", ["moderation", "deepfake", "--org", ORG, "--project", PROJECT, "--url", "https://e.test/1.png", "--threshold", "abc"]],
  ])("refuses it on `moderation %s` too", async (_n, argv) => {
    await expectRefusal(argv, /Invalid --threshold/);
  });

  it("POSITIVE CONTROL: a valid threshold reaches the server VERBATIM", async () => {
    const code = await run([...IMG, "--threshold", "0.7"]);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    // 0.7, not null, not undefined, not the server's default.
    expect(sent.threshold).toBe(0.7);
    expect(sent.imageUrl).toBe("https://e.test/a.png");
    expect(stdout.join("\n")).toContain("clean");
  });

  it("POSITIVE CONTROL: 0 and 1 are legitimate thresholds and are not dropped", async () => {
    for (const t of ["0", "1"]) {
      fetchSpy.mockClear();
      expect(await run([...IMG, "--threshold", t])).toBe(0);
      const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
      expect(sent.threshold).toBe(Number(t));
    }
  });

  it("POSITIVE CONTROL: omitting --threshold still runs, with the field absent", async () => {
    expect(await run(IMG)).toBe(0);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent.threshold).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The remaining defects
// ─────────────────────────────────────────────────────────────────────────────

describe("-n / --limit was silently ignored or forwarded on five commands", () => {
  it.each([
    ["scans", "-n"], ["traces", "-n"], ["prompts", "-n"],
  ])("refuses a bad %s %s", async (cmd, flag) => {
    for (const bad of ["abc", "2.7", "-5", "0", "99999999999"]) {
      fetchSpy.mockClear();
      stderr = [];
      await expectRefusal([cmd, "--project", PROJECT, flag, bad], /Invalid -n, --limit/);
    }
  });

  it("refuses a bad -n on `webhooks test` (it went out as `limit=NaN`)", async () => {
    await expectRefusal(["webhooks", "test", UUID, "-n", "abc"], /Invalid -n, --limit/);
  });

  it("refuses a bad --limit on `logs list`", async () => {
    await expectRefusal(["logs", "list", "--project", PROJECT, "--limit", "abc"], /Invalid --limit/);
  });

  it("`logs list` no longer advertises a `-n` the PARENT command swallows", async () => {
    // 23rd defect, found while validating the 22: `logs` declares
    // `-n, --lines`, and Commander lets a parent option consume a token after
    // the subcommand name — so `logs list -n 7` silently kept limit=100.
    // Adding validation to a flag that cannot arrive would have been a check
    // that passes because it never runs.
    const program = new Command();
    registerLogs(program);
    const list = program.commands.find((c) => c.name() === "logs")?.commands.find((c) => c.name() === "list");
    const shorts = (list?.options ?? []).map((o) => o.short);
    expect(shorts).not.toContain("-n");
    expect((list?.options ?? []).map((o) => o.long)).toContain("--limit");
  });

  it("POSITIVE CONTROL: a valid -n reaches the server as that exact number", async () => {
    expect(await run(["scans", "--project", PROJECT, "-n", "25"])).toBe(0);
    expect(new URL(String(fetchSpy.mock.calls[0][0])).searchParams.get("limit")).toBe("25");
  });

  it("POSITIVE CONTROL: the Commander DEFAULT (no -n given) still works everywhere", async () => {
    for (const argv of [
      ["scans", "--project", PROJECT],
      ["traces", "--project", PROJECT],
      ["prompts", "--project", PROJECT],
      ["logs", "list", "--project", PROJECT],
      ["webhooks", "test", UUID],
    ]) {
      fetchSpy.mockClear();
      expect(await run(argv), `default path broke for: ${argv.join(" ")}`).toBe(0);
      expect(fetchSpy).toHaveBeenCalled();
    }
  });
});

describe("logs list :: an inverted range read as a clean result", () => {
  it("refuses --since after --until", async () => {
    await expectRefusal(
      ["logs", "list", "--project", PROJECT, "--since", "2026-08-09", "--until", "2026-08-01"],
      /Invalid range: --since .* is after --until/,
    );
  });

  it("aligns the already-validated flags to the same exit code (they were 1)", async () => {
    // The gap here was INCONSISTENCY: `--since garbage` and `--sample abc`
    // were validated but threw, landing on exit 1 via reportFatal, while
    // every other refusal in the CLI is exit 2.
    await expectRefusal(["logs", "list", "--project", PROJECT, "--since", "garbage"], /Invalid --since/);
    stderr = [];
    fetchSpy.mockClear();
    await expectRefusal(["logs", "list", "--project", PROJECT, "--sample", "-3"], /Invalid --sample/);
  });

  it("POSITIVE CONTROL: a forward range is sent as the filter, and --sample 0 survives", async () => {
    expect(
      await run(["logs", "list", "--project", PROJECT, "--since", "2026-08-01", "--until", "2026-08-09", "--sample", "0"]),
    ).toBe(0);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname.endsWith("/monitoring")).toBe(true);
    expect(url.searchParams.get("startDate")).toBe("2026-08-01T00:00:00.000Z");
    expect(url.searchParams.get("endDate")).toBe("2026-08-09T00:00:00.000Z");
  });
});

describe("ids that were taken on trust while their siblings validated theirs", () => {
  it.each([
    ["runs get", ["runs", "get", "not-a-uuid"], /Invalid eval run id/],
    ["runs get ../../scorers", ["runs", "get", "../../scorers"], /Invalid eval run id/],
    ["scans get", ["scans", "get", "not-a-uuid"], /Invalid security scan id/],
    ["budget get", ["budget", "get", "not-a-uuid"], /Invalid API key id/],
    ["budget set", ["budget", "set", "not-a-uuid", "10"], /Invalid API key id/],
    ["budget clear", ["budget", "clear", "not-a-uuid"], /Invalid API key id/],
    ["budget period", ["budget", "period", "not-a-uuid", "daily"], /Invalid API key id/],
    ["budget limits", ["budget", "limits", "not-a-uuid", "--tpm", "10"], /Invalid API key id/],
  ])("refuses a non-UUID on `%s`", async (_n, argv, re) => {
    await expectRefusal(argv as string[], re as RegExp);
  });

  it("POSITIVE CONTROL: a real UUID still fetches the record", async () => {
    expect(await run(["runs", "get", UUID])).toBe(0);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/evals/${UUID}`);
  });
});

describe("vuln-lookup :: a bad PURL was a TypeError, not a validation message", () => {
  it("refuses a string that is not a pkg: URL, naming it", async () => {
    await expectRefusal(["vuln-lookup", "not-a-purl"], /Invalid PURL: "not-a-purl"/);
  });

  it("refuses the bad one even when mixed with good ones", async () => {
    await expectRefusal(["vuln-lookup", "pkg:npm/lodash@4.17.21", "nope"], /Invalid PURL: "nope"/);
  });

  it("POSITIVE CONTROL: a valid PURL is looked up", async () => {
    expect(await run(["vuln-lookup", "pkg:npm/lodash@4.17.21"])).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).purls).toEqual([
      "pkg:npm/lodash@4.17.21",
    ]);
  });

  it("POSITIVE CONTROL: an UNSUPPORTED ecosystem still goes to the server", async () => {
    // The route's documented contract is that unsupported PURLs are reported
    // in-band with a reason. A client-side ecosystem allow-list would swallow
    // that; only malformed SYNTAX is refused here.
    expect(await run(["vuln-lookup", "pkg:cargo/serde@1.0.0"])).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("crash-shaped gaps :: an unhandled stack is not a refusal", () => {
  it("`budget get` renders a 200 that omits remainingUsd / percentUsed", async () => {
    // Was: TypeError: Cannot read properties of undefined (reading 'toFixed')
    const code = await run(["budget", "get", UUID]);
    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("$100.00"); // the cap it DID send
    expect(out).toContain("Remaining");
    expect(out).not.toContain("undefined");
  });

  it("`decision-bom verify` refuses a 200 with no `verdict` instead of throwing on it", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { id: "bom-1", verification: { valid: true }, surface: "gateway" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const code = await run(["decision-bom", "verify", UUID]);
    expect(code).toBe(1); // ran, and failed — not a usage error
    const said = stderr.join("\n");
    expect(said).toMatch(/missing `verdict`/);
    expect(said).not.toMatch(/toUpperCase/); // never a raw stack again
  });

  it("POSITIVE CONTROL: a complete Decision-BOM still verifies and exits 0", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "bom-1", decisionId: "d-1", surface: "gateway", verdict: "allow",
            category: "none", signedAt: "2026-08-01T00:00:00Z",
            signature: { algorithm: "Ed25519", value: "v", publicKeyPem: "p" },
            verification: { valid: true },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await run(["decision-bom", "verify", UUID])).toBe(0);
    expect(stdout.join("\n")).toContain("ALLOW");
    expect(stdout.join("\n")).toContain("VALID");
  });
});
