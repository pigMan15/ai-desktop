import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KnowledgeDiffViewer } from "./KnowledgeDiffViewer";

afterEach(cleanup);

const sample = [
  "--- a/candidate/release-check.md",
  "+++ b/main/release-check.md",
  "@@ -1,3 +1,3 @@",
  " status: candidate",
  "-status: candidate",
  "+status: confirmed",
  " 内容",
].join("\n");

describe("KnowledgeDiffViewer", () => {
  it("renders file header, hunk, add and del lines with colored classes", () => {
    const { container } = render(<KnowledgeDiffViewer diff={sample} />);
    expect(screen.getByText("main/release-check.md")).toHaveClass("knowledge-diff-line--file");
    expect(screen.getByText("@@ -1,3 +1,3 @@")).toHaveClass("knowledge-diff-line--hunk");
    expect(screen.getByText("+status: confirmed")).toHaveClass("knowledge-diff-line--add");
    expect(screen.getByText("-status: candidate")).toHaveClass("knowledge-diff-line--del");
    expect(screen.getByText("status: candidate")).toHaveClass("knowledge-diff-line--ctx");
    expect(screen.getByRole("log", { name: "统一 diff" })).toBeTruthy();
    expect(container.textContent).toContain("1 个文件");
  });
});
