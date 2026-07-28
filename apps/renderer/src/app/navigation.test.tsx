import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Navigation } from "./navigation";

it("marks the active route and emits hash links", () => {
  render(<Navigation currentRoute="runs" />);

  expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("href", "#/runs");
  expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Projects" })).not.toHaveAttribute("aria-current");
});
