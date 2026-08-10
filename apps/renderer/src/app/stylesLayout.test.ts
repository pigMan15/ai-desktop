import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Run Agent executor layout", () => {
  it("uses a stable viewport-bounded height for the embedded executor", () => {
    const css = readFileSync(path.resolve(process.cwd(), "src/app/styles.css"), "utf8");

    expect(css).toMatch(/\.run-console-workspace\s*\{[^}]*align-content:\s*start/);
    expect(css).toMatch(/\.run-console-workspace\s*>\s*\.run-agent-executor \.terminal-surface\s*\{[^}]*height:\s*clamp\(32rem,\s*68dvh,\s*56rem\)/);
    expect(css).not.toMatch(/\.run-console-workspace\s*>\s*\.run-agent-executor\s*\{[^}]*height:\s*100%/);
    expect(css).not.toMatch(/\.run-console-workspace\s*>\s*\.run-agent-executor \.run-agent-executor-body\s*\{[^}]*height:\s*100%/);
  });
});
