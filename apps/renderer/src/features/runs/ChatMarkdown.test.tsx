import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it("renders bold and italic inline text", () => {
    render(<ChatMarkdown text={"hello **world** and *emphasis*"} />);
    expect(screen.getByText("world").tagName).toBe("STRONG");
    expect(screen.getByText("emphasis").tagName).toBe("EM");
  });

  it("renders inline code and highlighted code fences", () => {
    render(
      <ChatMarkdown
        text={"run `npm test` first\n```ts\nconst x = 1;\n```\nafter"}
      />,
    );
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    const codeBlock = screen.getByText((_content, element) => element?.tagName === "CODE" && (element.textContent ?? "").includes("const x = 1;"));
    expect(codeBlock.closest("pre")).not.toBeNull();
    expect(codeBlock.className).toContain("hljs");
    expect(screen.getByText(/after/)).toBeInTheDocument();
  });

  it("renders links opening in a new tab", () => {
    render(<ChatMarkdown text={"see [docs](https://example.com) please"} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders GFM tables and task lists", () => {
    render(
      <ChatMarkdown
        text={"| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo"}
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it("ignores raw HTML from model output", () => {
    render(<ChatMarkdown text={"<script>alert(1)</script>safe"} />);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/alert\(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/safe/)).toBeInTheDocument();
  });
});
