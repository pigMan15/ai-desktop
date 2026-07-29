import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Navigation } from "./navigation";

it("marks the active route and emits hash links", () => {
  render(<Navigation currentRoute="runs" />);

  expect(screen.getByRole("link", { name: "运行" })).toHaveAttribute("href", "#/runs");
  expect(screen.getByRole("link", { name: "运行" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "项目" })).not.toHaveAttribute("aria-current");
});
