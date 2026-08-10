import type { RunStatus, RunSummaryProjection } from "@workflow-platform/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildTerminalRunOptions,
  filterTerminalRunOptions,
  isTerminalRunBindable,
  loadAllTerminalRuns,
} from "./terminalRunModel";

describe("terminalRunModel", () => {
  it("keeps the active Run first and marks terminal states read-only", () => {
    const options = buildTerminalRunOptions([
      run("run-old", "DONE", "2026-08-01T00:00:00Z", "Old workflow", "1"),
      run("run-live", "IN_PROGRESS", "2026-08-02T00:00:00Z", "Current workflow", "2"),
      run("run-paused", "PAUSED", "2026-08-03T00:00:00Z", "Current workflow", "2"),
    ], "run-live");

    expect(options.map((item) => item.id)).toEqual(["run-live", "run-paused", "run-old"]);
    expect(options.find((item) => item.id === "run-old")?.bindable).toBe(false);
    expect(isTerminalRunBindable("ARCHIVED")).toBe(false);
    expect(isTerminalRunBindable("BLOCKED")).toBe(true);
  });

  it("searches title and ID and hides ended Runs by default", () => {
    const options = buildTerminalRunOptions([
      run("run-release", "IN_PROGRESS", "2026-08-02T00:00:00Z", "Release", "2"),
      run("run-legacy", "DONE", "2026-08-01T00:00:00Z", "Legacy", "1"),
    ], null);

    expect(filterTerminalRunOptions(options, "", false).map((item) => item.id)).toEqual(["run-release"]);
    expect(filterTerminalRunOptions(options, "legacy", true).map((item) => item.id)).toEqual(["run-legacy"]);
    expect(filterTerminalRunOptions(options, "run-release", true).map((item) => item.id)).toEqual(["run-release"]);
  });

  it("loads every project Run page and rejects a repeated cursor", async () => {
    const loadPage = vi.fn()
      .mockResolvedValueOnce({
        items: [run("run-new", "IN_PROGRESS", "2026-08-02T00:00:00Z", "Current", "2")],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        items: [run("run-old", "DONE", "2026-08-01T00:00:00Z", "Legacy", "1")],
        nextCursor: null,
      });

    await expect(loadAllTerminalRuns(loadPage)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "run-new" }),
      expect.objectContaining({ id: "run-old" }),
    ]));
    expect(loadPage.mock.calls).toEqual([[undefined], ["page-2"]]);

    const repeated = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: "same" })
      .mockResolvedValueOnce({ items: [], nextCursor: "same" });
    await expect(loadAllTerminalRuns(repeated)).rejects.toThrow("Repeated project Run cursor: same");
  });
});

function run(
  id: string,
  status: RunStatus,
  createdAt: string,
  workflowName: string,
  workflowVersion: string,
): RunSummaryProjection {
  return {
    id,
    projectId: "project-1",
    workflowVersionId: `workflow-version-${workflowVersion}`,
    workflowName,
    workflowVersion,
    title: id,
    status,
    taskGoal: null,
    currentNodes: [],
    nextNodes: [],
    progress: { total: 1, passed: 0, running: 0, blocked: 0, pending: 1 },
    blocker: null,
    workspace: null,
    activeAgentCount: 0,
    activeDeploymentCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}
