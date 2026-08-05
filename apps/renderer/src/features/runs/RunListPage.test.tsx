import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunListQuery, RunListResponse, RunSummaryProjection } from "@workflow-platform/contracts";
import { RuntimeClientError } from "../../app/runtimeClient";
import { RunListPage } from "./RunListPage";

function summary(overrides: Partial<RunSummaryProjection> = {}): RunSummaryProjection {
  return {
    id: "run-1234567890",
    projectId: "project-1",
    workflowVersionId: "workflow-version-1",
    workflowName: "发布工作流",
    workflowVersion: "3",
    title: "生产发布准备",
    status: "BLOCKED",
    taskGoal: "发布候选版本",
    currentNodes: [
      { id: "implement", name: "实现", kind: "agent", state: "RUNNING" },
      { id: "review", name: "复核", kind: "approval", state: "BLOCKED" },
    ],
    nextNodes: [
      { id: "gate", name: "质量门禁", kind: "gate" },
      { id: "deploy", name: "部署", kind: "task" },
    ],
    progress: { total: 8, passed: 3, running: 1, blocked: 1, pending: 3 },
    blocker: { code: "APPROVAL_REQUIRED", message: "等待发布负责人批准", nodeId: "review" },
    workspace: {
      path: "G:\\project\\release",
      label: "release-candidate",
      leaseMode: "write",
      leaseStatus: "active",
    },
    activeAgentCount: 2,
    activeDeploymentCount: 1,
    createdAt: "2026-08-05T09:00:00Z",
    updatedAt: "2026-08-05T10:00:00Z",
    ...overrides,
  };
}

function renderPage(options: {
  loadRuns?: (query: RunListQuery, signal: AbortSignal) => Promise<RunListResponse>;
  onOpenRun?: (runId: string) => void;
  onNewRun?: () => void;
} = {}) {
  const loadRuns = options.loadRuns ?? vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null });
  const onOpenRun = options.onOpenRun ?? vi.fn();
  const onNewRun = options.onNewRun ?? vi.fn();
  const view = render(
    <RunListPage
      projectId="project-1"
      projectName="桌面平台"
      workflowName="发布工作流"
      workspaces={[
        { path: "G:\\project", label: "main" },
        { path: "G:\\project\\release", label: "release-candidate" },
      ]}
      loadRuns={loadRuns}
      onOpenRun={onOpenRun}
      onNewRun={onNewRun}
    />,
  );
  return { loadRuns, onOpenRun, onNewRun, unmount: view.unmount };
}

beforeEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RunListPage", () => {
  it("renders project-scoped summary fields and opens rows with pointer or keyboard", async () => {
    const onOpenRun = vi.fn();
    renderPage({ onOpenRun });

    expect(await screen.findByText("生产发布准备")).toBeInTheDocument();
    const row = screen.getByTestId("run-row-run-1234567890");
    expect(within(row).getByText("run-1234...")).toBeInTheDocument();
    expect(within(row).getByText("发布工作流 v3")).toBeInTheDocument();
    expect(within(row).getByText("3 / 8")).toBeInTheDocument();
    expect(within(row).getByText("实现、复核")).toBeInTheDocument();
    expect(within(row).getByText("下一步：质量门禁、部署")).toBeInTheDocument();
    expect(within(row).getByText("等待发布负责人批准")).toBeInTheDocument();
    expect(within(row).getByText(/release-candidate/)).toBeInTheDocument();
    expect(within(row).getByText("Agent 2 / 部署 1")).toBeInTheDocument();

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onOpenRun).toHaveBeenCalledTimes(3);
    expect(onOpenRun).toHaveBeenLastCalledWith("run-1234567890");
  });

  it("shows distinct initial and filtered empty states", async () => {
    const loadRuns = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    renderPage({ loadRuns });
    expect(await screen.findByText("尚无 Run")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索 Run"), { target: { value: "missing" } });
    expect(await screen.findByText("没有符合条件的 Run")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(screen.getByLabelText("搜索 Run")).toHaveValue(""));
  });

  it("serializes user filters and appends an opaque-cursor page", async () => {
    const loadRuns = vi.fn(async (query: RunListQuery) => {
      if (query.cursor === "opaque+/=") {
        return { items: [summary({ id: "run-2", title: "第二个 Run" })], nextCursor: null };
      }
      return { items: [summary()], nextCursor: "opaque+/=" };
    });
    renderPage({ loadRuns });
    await screen.findByText("生产发布准备");

    fireEvent.click(screen.getByLabelText("状态 BLOCKED"));
    fireEvent.change(screen.getByLabelText("执行工作区"), { target: { value: "G:\\project\\release" } });
    await waitFor(() => {
      expect(loadRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ["BLOCKED"], workspacePath: "G:\\project\\release", limit: 20 }),
        expect.any(AbortSignal),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("第二个 Run")).toBeInTheDocument();
    expect(loadRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "opaque+/=" }),
      expect.any(AbortSignal),
    );
  });

  it("retains rows and refresh time when a manual refresh fails", async () => {
    let calls = 0;
    const loadRuns = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { items: [summary()], nextCursor: null };
      throw new RuntimeClientError(
        503,
        "RUN_REARCHITECTURE_MAINTENANCE",
        "运行模块正在维护",
        undefined,
        "correlation-1",
      );
    });
    renderPage({ loadRuns });
    await screen.findByText("生产发布准备");
    const refreshedText = screen.getByText(/上次刷新/).textContent;

    fireEvent.click(screen.getByRole("button", { name: "刷新 Run 列表" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("运行模块正在维护");
    expect(alert).toHaveTextContent("correlation-1");
    expect(screen.getByText("生产发布准备")).toBeInTheDocument();
    expect(screen.getByText(/上次刷新/).textContent).toBe(refreshedText);
  });

  it("refreshes every ten seconds while visible and aborts on unmount", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const loadRuns = vi.fn((_: RunListQuery, signal: AbortSignal) => {
      signals.push(signal);
      return Promise.resolve({ items: [summary()], nextCursor: null });
    });
    const view = renderPage({ loadRuns });
    await act(async () => Promise.resolve());
    expect(loadRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(loadRuns).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(loadRuns).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("refreshes on focus and exposes new-Run and refresh commands", async () => {
    const onNewRun = vi.fn();
    const { loadRuns } = renderPage({ onNewRun });
    await screen.findByText("生产发布准备");

    fireEvent.click(screen.getByRole("button", { name: "新建 Run" }));
    expect(onNewRun).toHaveBeenCalledOnce();

    fireEvent.focus(window);
    await waitFor(() => expect(loadRuns).toHaveBeenCalledTimes(2));
  });
});
