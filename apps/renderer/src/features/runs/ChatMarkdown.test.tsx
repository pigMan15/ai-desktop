import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it("renders bold and italic inline text", () => {
    render(<ChatMarkdown text={"hello **world** and *emphasis*"} />);
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    expect(screen.getByText("world").tagName).toBe("STRONG");
    expect(screen.getByText("emphasis").tagName).toBe("EM");
  });

  it("renders inline code and code fences", () => {
    render(
      <ChatMarkdown
        text={"run `npm test` first\n```ts\nconst x = 1;\n```\nafter"}
      />,
    );
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(screen.getByText("const x = 1;").closest("pre")).not.toBeNull();
    expect(screen.getByText(/after/)).toBeInTheDocument();
  });

  it("renders links", () => {
    render(<ChatMarkdown text={"see [docs](https://example.com) please"} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });
});
