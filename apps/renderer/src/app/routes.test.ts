import { describe, expect, it } from "vitest";
import { normalizeRoute, routes } from "./routes";

describe("normalizeRoute", () => {
  it("uses projects for empty and unknown hashes", () => {
    expect(normalizeRoute("")).toBe("projects");
    expect(normalizeRoute("#/unknown")).toBe("projects");
  });

  it("accepts every declared menu hash", () => {
    for (const route of routes) {
      expect(normalizeRoute(route.hash)).toBe(route.id);
    }
  });
});
