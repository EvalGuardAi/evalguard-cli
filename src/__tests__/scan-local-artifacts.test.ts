/**
 * `evalguard scan:local` artifact selection + CI provenance.
 *
 * These two pure helpers decide WHERE a scan's findings end up and what
 * repository/commit they claim to describe — both are load-bearing for the
 * SARIF upload (wrong provenance = alerts attached to the wrong commit) and
 * for the "just point --output at a .html" ergonomics.
 */

import { describe, it, expect } from "vitest";
import { formatFromPath, ciProvenance } from "../commands/scan-local";

describe("formatFromPath", () => {
  it("detects SARIF from .sarif", () => {
    expect(formatFromPath("out/report.sarif")).toBe("sarif");
  });

  it("detects SARIF from the .sarif.json double extension", () => {
    expect(formatFromPath("report.sarif.json")).toBe("sarif");
  });

  it("detects HTML from .html and .htm", () => {
    expect(formatFromPath("report.html")).toBe("html");
    expect(formatFromPath("report.htm")).toBe("html");
  });

  it("detects JSON from .json", () => {
    expect(formatFromPath("report.json")).toBe("json");
  });

  it("is case-insensitive", () => {
    expect(formatFromPath("REPORT.SARIF")).toBe("sarif");
    expect(formatFromPath("Report.HTML")).toBe("html");
  });

  it("returns undefined for an unrecognised extension so --format decides", () => {
    expect(formatFromPath("report.txt")).toBeUndefined();
    expect(formatFromPath("report")).toBeUndefined();
  });

  it("prefers sarif over json for .sarif.json (checked before the .json suffix)", () => {
    expect(formatFromPath("a/b/c.sarif.json")).toBe("sarif");
  });
});

describe("ciProvenance", () => {
  it("is empty outside CI — nothing invented", () => {
    expect(ciProvenance({})).toEqual({});
  });

  it("builds a repository URI from the standard variables", () => {
    expect(ciProvenance({ GITHUB_REPOSITORY: "acme/app" }).repositoryUri).toBe(
      "https://github.com/acme/app",
    );
  });

  it("honours a self-hosted server URL", () => {
    expect(
      ciProvenance({ GITHUB_REPOSITORY: "acme/app", GITHUB_SERVER_URL: "https://ghe.acme.dev/" })
        .repositoryUri,
    ).toBe("https://ghe.acme.dev/acme/app");
  });

  it("carries the revision and branch through", () => {
    const p = ciProvenance({ GITHUB_SHA: "abc123", GITHUB_REF: "refs/heads/main" });
    expect(p.revisionId).toBe("abc123");
    expect(p.branch).toBe("refs/heads/main");
  });

  it("derives a per-ref automationId so re-runs replace rather than stack alerts", () => {
    expect(ciProvenance({ GITHUB_REF: "refs/pull/7/merge" }).automationId).toBe(
      "evalguard-red-team/refs/pull/7/merge",
    );
  });

  it("omits automationId when there is no ref to key on", () => {
    expect(ciProvenance({ GITHUB_SHA: "abc" }).automationId).toBeUndefined();
  });

  it("converts a POSIX workspace into a file:// srcRoot", () => {
    expect(ciProvenance({ GITHUB_WORKSPACE: "/home/runner/work/app" }).srcRoot).toBe(
      "file:///home/runner/work/app",
    );
  });

  it("converts a Windows workspace into a file:// srcRoot", () => {
    expect(ciProvenance({ GITHUB_WORKSPACE: "D:\\a\\app\\app" }).srcRoot).toBe(
      "file:///D:/a/app/app",
    );
  });
});
