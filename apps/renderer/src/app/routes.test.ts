import { describe, expect, it } from "vitest";
import {
  buildRunAgentExecutorHash,
  buildRunDetailHash,
  buildRunModuleHash,
  isKnownRouteHash,
  normalizeRoute,
  parseRunRoute,
  parseScopedRunRoute,
  routes,
  type RunContext,
} from "./routes";

describe("scoped Run routes", () => {
  const context: RunContext = {
    projectId: "project /上海",
    runId: "run ?#&=+",
  };

  it("builds a Run detail hash with an encoded identifier", () => {
    expect(buildRunDetailHash("run /上海?#")).toBe(
      "#/runs/run%20%2F%E4%B8%8A%E6%B5%B7%3F%23",
    );
  });

  it("round-trips the canonical Run Agent executor route", () => {
    const hash = buildRunAgentExecutorHash("run /上海", "job ?7/#");

    expect(hash).toBe(
      "#/runs/run%20%2F%E4%B8%8A%E6%B5%B7/agents/job%20%3F7%2F%23",
    );
    expect(parseRunRoute(hash)).toEqual({
      mode: "agent",
      runId: "run /上海",
      jobId: "job ?7/#",
    });
    expect(normalizeRoute(hash)).toBe("runs");
  });

  it("keeps the bare terminal route independent from Run context", () => {
    expect(normalizeRoute("#/terminal")).toBe("terminal");
    expect(parseScopedRunRoute("#/terminal", "project-1")).toEqual({ mode: "none" });
  });

  it.each(["artifacts", "gates", "approvals", "deployment", "audit", "recovery"] as const)(
    "round-trips the %s module route with encoded context",
    (module) => {
      const hash = buildRunModuleHash(module, context);

      expect(hash).toBe(
        `#/${module}?projectId=project+%2F%E4%B8%8A%E6%B5%B7&runId=run+%3F%23%26%3D%2B`,
      );
      expect(parseScopedRunRoute(hash, context.projectId)).toEqual({ mode: module, context });
    },
  );

  it("returns none for routes without scoped Run context", () => {
    expect(parseScopedRunRoute("#/projects", "project-1")).toEqual({ mode: "none" });
    expect(parseScopedRunRoute("#/runs/run-1", "project-1")).toEqual({ mode: "none" });
  });

  it.each([
    ["missing query context", "#/artifacts", "project-1"],
    ["missing project ID", "#/artifacts?runId=run-1", "project-1"],
    ["missing Run ID", "#/artifacts?projectId=project-1", "project-1"],
    ["empty project ID", "#/gates?projectId=&runId=run-1", "project-1"],
    ["empty Run ID", "#/gates?projectId=project-1&runId=", "project-1"],
    ["blank project ID", "#/audit?projectId=+++&runId=run-1", "   "],
    ["blank Run ID", "#/audit?projectId=project-1&runId=+++", "project-1"],
    ["duplicate project ID", "#/recovery?projectId=project-1&projectId=project-1&runId=run-1", "project-1"],
    ["duplicate Run ID", "#/recovery?projectId=project-1&runId=run-1&runId=run-1", "project-1"],
    ["mismatched project", "#/approvals?projectId=other&runId=run-1", "project-1"],
    ["malformed query encoding", "#/deployment?projectId=project-1&runId=%E0%A4%A", "project-1"],
  ])("rejects %s", (_case, hash, activeProjectId) => {
    expect(parseScopedRunRoute(hash, activeProjectId)).toEqual({ mode: "invalid" });
  });
});

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
    expect(parseRunRoute("#/runs/run%2Fone?tab=overview")).toEqual({ mode: "detail", runId: "run/one" });
  });

  it("rejects malformed, empty, trailing-slash, and deeper run paths", () => {
    expect(parseRunRoute("#/runs/%")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/logs")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/agents")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/agents/")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/agents/job-1/output")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/%20/agents/job-1")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/agents/%20")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/%E0%A4%A/agents/job-1")).toEqual({ mode: "unknown" });
    expect(parseRunRoute("#/runs/run-1/agents/%E0%A4%A")).toEqual({ mode: "unknown" });
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

  it("recognizes canonical Run Agent and scoped module URLs", () => {
    expect(normalizeRoute("#/runs/run-1/agents/job-1")).toBe("runs");
    expect(normalizeRoute("#/artifacts?projectId=project-1&runId=run-1")).toBe("artifacts");
    expect(normalizeRoute("#/gates?projectId=project-1&runId=run-1")).toBe("gates");
    expect(normalizeRoute("#/approvals?projectId=project-1&runId=run-1")).toBe("approvals");
    expect(normalizeRoute("#/audit?projectId=project-1&runId=run-1")).toBe("audit");
    expect(normalizeRoute("#/recovery?projectId=project-1&runId=run-1")).toBe("recovery");
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

  it("recognizes canonical Run Agent and every scoped module URL", () => {
    expect(isKnownRouteHash("#/runs/run-1/agents/job-1")).toBe(true);
    for (const module of ["artifacts", "gates", "approvals", "deployment", "audit", "recovery"]) {
      expect(isKnownRouteHash(`#/${module}?projectId=project-1&runId=run-1`)).toBe(true);
    }
  });
});
