/**
 * apps/cli is `"type": "module"` and is built by plain `tsc` (module: NodeNext)
 * — no bundler, no CJS wrapper. `require` therefore does not exist in any
 * emitted module, and a bare `require(...)` is dead code that throws
 * `ReferenceError: require is not defined` the moment its line is reached.
 *
 * MEASURED before the fix, running the body of `openBrowser()` from
 * src/commands/view.ts in this package's own module system:
 *
 *     typeof require     : undefined
 *     RESULT: ReferenceError: require is not defined
 *     => `evalguard view` cannot open a browser; the command throws here.
 *
 * That is the same defect class as audit F109 in @evalguard/otel-sdk, where 27
 * instrumentor call sites were inert for the same reason. This ratchet stops it
 * coming back in a third place. A module that genuinely needs CommonJS
 * resolution must bind `require` itself via `createRequire(import.meta.url)` —
 * which src/index.ts correctly does, and which this test allows.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const SRC = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "fixtures" || entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments and string literals so only executable code is inspected. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^\\"])*"/g, '""')
    .replace(/'(?:\\.|[^\\'])*'/g, "''");
}

/**
 * Files calling `require(...)` without binding it from `createRequire`.
 * Exported shape kept simple so the failure message names the offenders.
 */
export function bareRequireOffenders(files: string[]): string[] {
  return files.filter((file) => {
    const body = code(readFileSync(file, "utf8"));
    const callsRequire = /(^|[^.\w$])require\s*\(/m.test(body);
    if (!callsRequire) return false;
    const bindsRequire = /\b(?:const|let|var)\s+require\s*=|createRequire\s*\(/.test(body);
    return !bindsRequire;
  });
}

describe("apps/cli is ESM: no bare require() in shipped source", () => {
  const files = sourceFiles(SRC);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no module that calls require() without binding it via createRequire", () => {
    const offenders = bareRequireOffenders(files).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("still allows the legitimate createRequire pattern (src/index.ts)", () => {
    const indexSource = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(indexSource).toContain("createRequire(import.meta.url)");
    expect(bareRequireOffenders([join(SRC, "index.ts")])).toEqual([]);
  });
});
