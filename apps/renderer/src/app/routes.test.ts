import { describe, expect, it } from "vitest";
import { isKnownRouteHash, normalizeRoute, parseRunRoute, routes } from "./routes";

describe("parseRunRoute", () => {
  it("parses the runs list route with or without a query", () => {
    expect(parseRunRoute("#/runs")).toEqual({ mode: "list" });
    expect(parseRunRoute("#/runs?status=running")).toEqual({ mode: "list" });
  });

  it("parses the new run route", () => {
    expect(parseRunRoute("#/runs/new")).toEqual({ mode: "new" });
  });

  it("decodes a non-empty run ID from one path segment", () => {
    expect(parseRunRoute("#/runs/run%201")).toEqual({ mode: "detail", runId: "run 1" });
  });

  it("rejects malformed, empty, trailing-slash, and deeper run paths", () => {
    expect(parseRunRoute("#/runs/%")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/logs")).toEqual({ mode: "unknown" });
  });
});

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

  it("recognizes valid Run URLs within the runs section", () => {
    expect(normalizeRoute("#/runs?status=running")).toBe("runs");
    expect(normalizeRoute("#/runs/new")).toBe("runs");
    expect(normalizeRoute("#/runs/run-1")).toBe("runs");
    expect(normalizeRoute("#/runs/run%201")).toBe("runs");
  });

  it("rejects malformed and deeper Run URLs", () => {
    expect(normalizeRoute("#/runs/%")).toBe("projects");
    expect(normalizeRoute("#/runs/run-1/")).toBe("projects");
    expect(normalizeRoute("#/runs/run-1/logs")).toBe("projects");
  });
});

describe("isKnownRouteHash", () => {
  it("recognizes valid Run URLs", () => {
    expect(isKnownRouteHash("#/runs")).toBe(true);
    expect(isKnownRouteHash("#/runs?status=running")).toBe(true);
    expect(isKnownRouteHash("#/runs/new")).toBe(true);
    expect(isKnownRouteHash("#/runs/run%201")).toBe(true);
  });

  it("rejects malformed and deeper Run URLs", () => {
    expect(isKnownRouteHash("#/runs/%")).toBe(false);
    expect(isKnownRouteHash("#/runs/run-1/")).toBe(false);
    expect(isKnownRouteHash("#/runs/run-1/logs")).toBe(false);
  });

  it("preserves workflow subroute recognition", () => {
    expect(isKnownRouteHash("#/workflow/new")).toBe(true);
    expect(isKnownRouteHash("#/workflow/workflow-1")).toBe(true);
  });
});
