import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Actor } from "@workflow-platform/contracts";
import { RuntimeClientError, type ScopedCreateRunResponse } from "../../app/runtimeClient";
import { NewRunPage } from "./NewRunPage";

const actor: Actor = { id: "renderer-human", type: "human", source: "renderer", trusted: true };

function createdRun(id = "run-created"): ScopedCreateRunResponse {
  return {
    run: {
      id,
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      workflowSnapshot: {} as ScopedCreateRunResponse["run"]["workflowSnapshot"],
      title: "发布准备",
      context: {},
      executionWorkspace: "G:\\project\\release",
      workspaceMode: "write",
      status: "CREATED",
      createdAt: "2026-08-06T00:00:00Z",
      updatedAt: "2026-08-06T00:00:00Z",
    },
    projection: {
      runId: id,
      status: "CREATED",
      currentNodeIds: [],
      nodeStates: {},
      allowedActions: [],
      blockingReasons: [],
      revision: "1",
      updatedAt: "2026-08-06T00:00:00Z",
    },
    workspace: {
      id: "lease-1",
      projectId: "project-1",
      runId: id,
      workspacePath: "G:\\project\\release",
      mode: "write",
      status: "active",
      acquiredAt: "2026-08-06T00:00:00Z",
      lastVerifiedAt: "2026-08-06T00:00:00Z",
      releasedAt: null,
      releaseReason: null,
    },
  };
}

function renderPage(options: {
  binding?: { workflowVersionId: string; workflowName: string } | null;
  workspaces?: Array<{
    path: string;
    branch: string;
    isMain: boolean;
    occupiedByRunId?: string | null;
    leaseStatus?: "active" | "released" | "expired";
    recommended?: boolean;
  }>;
  onCreate?: ReturnType<typeof vi.fn>;
  onCreated?: ReturnType<typeof vi.fn>;
  onCancel?: ReturnType<typeof vi.fn>;
  onOpenWorkflowLibrary?: ReturnType<typeof vi.fn>;
  createIdempotencyKey?: () => string;
} = {}) {
  const props = {
    project: { id: "project-1", name: "桌面平台" },
    binding: options.binding === undefined
      ? { workflowVersionId: "workflow-version-1", workflowName: "发布工作流" }
      : options.binding,
    workspaces: options.workspaces ?? [
      { path: "G:\\project", branch: "main", isMain: true },
      { path: "G:\\project\\release", branch: "release", isMain: false },
    ],
    actor,
    createIdempotencyKey: options.createIdempotencyKey,
    onCreate: options.onCreate ?? vi.fn().mockResolvedValue(createdRun()),
    onCreated: options.onCreated ?? vi.fn(),
    onCancel: options.onCancel ?? vi.fn(),
    onOpenWorkflowLibrary: options.onOpenWorkflowLibrary ?? vi.fn(),
  };
  render(<NewRunPage {...props} />);
  return props;
}

afterEach(cleanup);

describe("NewRunPage", () => {
  it("selects a recommended workspace and disables an actively leased write workspace", () => {
    renderPage({
      workspaces: [
        { path: "G:\\project", branch: "main", isMain: true, occupiedByRunId: "run-active", leaseStatus: "active" },
        { path: "G:\\project\\release", branch: "release", isMain: false, recommended: true },
      ],
    });

    const select = screen.getByLabelText("执行工作区");
    expect(select).toHaveValue("G:\\project\\release");
    expect(screen.getByRole("option", { name: /run-active/ })).toBeDisabled();
    expect(screen.getByRole("option", { name: /推荐/ })).toBeInTheDocument();
  });

  it("validates title, length, and object-only JSON without submitting", async () => {
    const { onCreate } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByText("请输入 Run 名称")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "x".repeat(121) } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByText("Run 名称不能超过 120 个字符")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "发布准备" } });
    fireEvent.change(screen.getByLabelText("运行参数"), { target: { value: "[]" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByText("运行参数必须是 JSON 对象")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("accepts a title at the 120-character boundary", async () => {
    const { onCreate } = renderPage();
    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "x".repeat(120) } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0][0].request.title).toHaveLength(120);
  });

  it("rejects JSON scalar parameters", async () => {
    const { onCreate } = renderPage();
    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "发布准备" } });
    fireEvent.change(screen.getByLabelText("运行参数"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));

    expect(await screen.findByText("运行参数必须是 JSON 对象")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("submits the selected workspace, parsed parameters, actor, and default write mode", async () => {
    const { onCreate, onCreated } = renderPage({ createIdempotencyKey: () => "key-1" });
    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "发布准备" } });
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "交付候选版本" } });
    fireEvent.change(screen.getByLabelText("运行参数"), { target: { value: "{\"channel\":\"beta\"}" } });
    fireEvent.change(screen.getByLabelText("执行工作区"), { target: { value: "G:\\project\\release" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      idempotencyKey: "key-1",
      request: {
        workflowVersionId: "workflow-version-1",
        title: "发布准备",
        taskGoal: "交付候选版本",
        parameters: { channel: "beta" },
        executionWorkspace: { path: "G:\\project\\release", mode: "write" },
        actor,
      },
    }));
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("run-created");
  });

  it("shows recovery actions for an unbound workflow or no workspaces", () => {
    const unbound = renderPage({ binding: null });
    expect(screen.getByText("当前项目尚未绑定工作流")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "前往工作流库" }));
    expect(unbound.onOpenWorkflowLibrary).toHaveBeenCalledOnce();
    cleanup();

    renderPage({ workspaces: [] });
    expect(screen.getByText("没有可用的执行工作区，请先在项目页创建或发现 Git worktree。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建 Run" })).toBeDisabled();
  });

  it("reuses an idempotency key for unchanged retries and rotates it after a form change", async () => {
    const keys = ["key-1", "key-2"];
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new RuntimeClientError(409, "WORKSPACE_LEASE_CONFLICT", "工作区已占用", undefined, "corr-1"))
      .mockRejectedValueOnce(new RuntimeClientError(409, "WORKSPACE_LEASE_CONFLICT", "工作区仍占用", undefined, "corr-2"))
      .mockResolvedValueOnce(createdRun());
    const onCreated = vi.fn();
    renderPage({ onCreate, onCreated, createIdempotencyKey: () => keys.shift() ?? "unexpected" });
    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "发布准备" } });
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "保留这个目标" } });
    fireEvent.change(screen.getByLabelText("运行参数"), { target: { value: "{\"channel\":\"beta\"}" } });
    fireEvent.change(screen.getByLabelText("执行工作区"), { target: { value: "G:\\project\\release" } });
    fireEvent.click(screen.getByRole("radio", { name: "只读" }));

    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByText("工作区已占用")).toBeInTheDocument();
    expect(screen.getByText("corr-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Run 名称")).toHaveValue("发布准备");
    expect(screen.getByLabelText("运行目标")).toHaveValue("保留这个目标");
    expect(screen.getByLabelText("运行参数")).toHaveValue("{\"channel\":\"beta\"}");
    expect(screen.getByLabelText("执行工作区")).toHaveValue("G:\\project\\release");
    expect(screen.getByRole("radio", { name: "只读" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "重试创建" }));
    expect(await screen.findByText("工作区仍占用")).toBeInTheDocument();
    expect(onCreate.mock.calls[0][0].idempotencyKey).toBe("key-1");
    expect(onCreate.mock.calls[1][0].idempotencyKey).toBe("key-1");

    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "更新后的目标" } });
    fireEvent.click(screen.getByRole("button", { name: "重试创建" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-created"));
    expect(onCreate.mock.calls[2][0].idempotencyKey).toBe("key-2");
    expect(screen.getByLabelText("Run 名称")).toHaveValue("发布准备");
  });

  it("disables duplicate submission while creation is pending and supports cancel", async () => {
    let resolveCreate: ((value: ScopedCreateRunResponse) => void) | undefined;
    const onCreate = vi.fn(() => new Promise<ScopedCreateRunResponse>((resolve) => { resolveCreate = resolve; }));
    const { onCancel } = renderPage({ onCreate });
    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "发布准备" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByRole("button", { name: "正在创建..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledOnce();

    resolveCreate?.(createdRun());
    await waitFor(() => expect(screen.queryByRole("button", { name: "正在创建..." })).not.toBeInTheDocument());
  });
});
