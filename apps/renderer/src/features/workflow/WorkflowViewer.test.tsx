import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowViewer } from "./WorkflowViewer";

afterEach(cleanup);

describe("WorkflowViewer", () => {
  it("renders node states and blocking reasons from the current Run projection", () => {
    render(
      <WorkflowViewer
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "demo",
          workflowName: "Demo Workflow",
          projection: {
            runId: "run-1",
            status: "REVIEWING",
            currentNodeIds: ["review"],
            nodeStates: { plan: "PASSED", review: "AWAITING_APPROVAL" },
            allowedActions: [],
            blockingReasons: [
              { code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "review" },
            ],
            revision: "4",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
      />,
    );

    expect(screen.getByText("当前 Run：run-1")).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
    expect(screen.getByText("PASSED")).toBeInTheDocument();
    expect(screen.getByText("WAITING_FOR_HUMAN：等待人工审批")).toBeInTheDocument();
  });

  it("renders the persisted workflow definition and compiler diagnostics", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [
            {
              id: "plan-ready",
              name: "计划产物检查",
              metadata: {
                automatic: {
                  requiredArtifactTypes: ["plan"],
                },
              },
            },
          ],
          policies: {},
          metadata: {},
        }}
        compiled={{
          diagnostics: [{ code: "EDGE_TARGET_MISSING", message: "目标节点不存在", edgeId: "edge-1" }],
          graphSpec: {
            nodes: [{ id: "plan", label: "制定计划", kind: "task" }],
            edges: [],
          },
        }}
      />,
    );

    expect(screen.getByText("示例工作流")).toBeInTheDocument();
    expect(screen.getAllByText("制定计划").length).toBeGreaterThan(0);
    expect(screen.getByText("EDGE_TARGET_MISSING：目标节点不存在")).toBeInTheDocument();
  });

  it("parses an edited workflow draft before saving a new version", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.change(screen.getByLabelText("工作流定义 JSON"), {
      target: {
        value: JSON.stringify({
          id: "demo-workflow",
          name: "已编辑工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "更新计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      name: "已编辑工作流",
      nodes: [expect.objectContaining({ name: "更新计划" })],
    }));
  });

  it("restores an unsaved workflow draft after the workflow route is remounted", () => {
    const workflow = {
      id: "demo-workflow",
      name: "示例工作流",
      version: "2",
      sourceAdapter: "harness",
      nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
      edges: [],
      roles: [],
      gates: [],
      policies: {},
      metadata: {},
    };
    const { unmount } = render(
      <WorkflowViewer
        state={null}
        workflowVersionId="workflow-version-demo"
        workflow={workflow}
      />,
    );

    fireEvent.change(screen.getByLabelText("工作流定义 JSON"), {
      target: { value: JSON.stringify({ ...workflow, name: "未保存的产物配置" }) },
    });
    unmount();

    render(
      <WorkflowViewer
        state={null}
        workflowVersionId="workflow-version-demo"
        workflow={workflow}
      />,
    );

    expect((screen.getByLabelText("工作流定义 JSON") as HTMLTextAreaElement).value).toContain(
      "未保存的产物配置",
    );
  });

  it("keeps the draft when saving a new version fails", async () => {
    const workflow = {
      id: "save-failure-workflow",
      name: "示例工作流",
      version: "2",
      sourceAdapter: "harness",
      nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
      edges: [],
      roles: [],
      gates: [],
      policies: {},
      metadata: {},
    };
    const onSaveDefinition = vi.fn().mockRejectedValue(new Error("保存请求失败"));
    const { unmount } = render(
      <WorkflowViewer
        state={null}
        workflowVersionId="workflow-version-save-failure"
        workflow={workflow}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.change(screen.getByLabelText("工作流定义 JSON"), {
      target: { value: JSON.stringify({ ...workflow, name: "保留失败草稿" }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(onSaveDefinition).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("保存新版本失败：保存请求失败")).toBeInTheDocument();
    unmount();

    render(
      <WorkflowViewer
        state={null}
        workflowVersionId="workflow-version-save-failure"
        workflow={workflow}
      />,
    );

    expect((screen.getByLabelText("工作流定义 JSON") as HTMLTextAreaElement).value).toContain(
      "保留失败草稿",
    );
  });

  it("requests and renders a non-persistent workflow simulation", () => {
    const onSimulate = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        simulation={{
          status: "ready",
          diagnostics: [],
          steps: [{ nodeId: "plan", state: "READY" }],
        }}
        onSimulate={onSimulate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "模拟版本" }));

    expect(onSimulate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("plan：READY")).toBeInTheDocument();
  });

  it("lets the operator choose the workflow export format", () => {
    const onExportWorkflow = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onExportWorkflow={onExportWorkflow}
      />,
    );

    fireEvent.change(screen.getByLabelText("导出格式"), { target: { value: "generic-yaml" } });
    fireEvent.click(screen.getByRole("button", { name: "导出工作流" }));

    expect(onExportWorkflow).toHaveBeenCalledWith("generic-yaml");
  });

  it("shows version history and requests a semantic comparison", () => {
    const onCompareVersion = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        history={[
          {
            id: "workflow-version-1",
            name: "示例工作流",
            version: "1",
            contentHash: "abc",
            createdAt: "2026-07-28T00:00:00Z",
          },
          {
            id: "workflow-version-2",
            name: "示例工作流",
            version: "2",
            contentHash: "def",
            createdAt: "2026-07-28T01:00:00Z",
          },
        ]}
        diff={{
          fromVersionId: "workflow-version-1",
          toVersionId: "workflow-version-2",
          addedNodes: [],
          removedNodes: [],
          changedNodes: [
            {
              id: "plan",
              changes: { name: { from: "旧计划", to: "制定计划" } },
            },
          ],
          addedEdges: [],
          removedEdges: [],
          changedEdges: [],
        }}
        onCompareVersion={onCompareVersion}
      />,
    );

    fireEvent.change(screen.getByLabelText("比较版本"), {
      target: { value: "workflow-version-1" },
    });

    expect(onCompareVersion).toHaveBeenCalledWith("workflow-version-1");
    expect(screen.getByText("plan：名称从“旧计划”变为“制定计划”")).toBeInTheDocument();
  });

  it("restores the selected historical version as a new version", () => {
    const onRestoreVersion = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        history={[{
          id: "workflow-version-1",
          name: "示例工作流",
          version: "1",
          contentHash: "abc",
          createdAt: "2026-07-28T00:00:00Z",
        }]}
        onCompareVersion={vi.fn()}
        onRestoreVersion={onRestoreVersion}
      />,
    );

    fireEvent.change(screen.getByLabelText("比较版本"), {
      target: { value: "workflow-version-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "恢复为新版本" }));

    expect(onRestoreVersion).toHaveBeenCalledWith("workflow-version-1");
  });

  it("adds a node and connection through the visual editor before saving", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "demo-workflow",
          name: "示例工作流",
          version: "2",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "制定计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.change(screen.getByLabelText("新节点 ID"), { target: { value: "review" } });
    fireEvent.change(screen.getByLabelText("新节点名称"), { target: { value: "人工审查" } });
    fireEvent.change(screen.getByLabelText("新节点类型"), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: "新增节点" }));

    fireEvent.change(screen.getByLabelText("连线起点"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("连线终点"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "新增连线" }));
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(screen.getByText("人工审查")).toBeInTheDocument();
    expect(screen.getByText("plan → review")).toBeInTheDocument();
    expect(onSaveDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "review", name: "人工审查", kind: "approval" }),
        ]),
        edges: [expect.objectContaining({ from: "plan", to: "review" })],
      }),
    );
  });

  it("only exposes Agent configuration for Agent nodes", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "agent-settings-workflow",
          name: "Agent 设置",
          version: "1",
          sourceAdapter: "harness",
          nodes: [
            { id: "plan", name: "计划", kind: "task" },
            { id: "implement", name: "实现", kind: "agent" },
          ],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
      />,
    );

    expect(screen.queryByLabelText(/plan.*Agent/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/implement.*Agent/)).toBeInTheDocument();
  });

  it("changes a node type to agent through the visual editor", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "node-kind-workflow",
          name: "节点类型设置",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "计划", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.change(screen.getByLabelText("plan 节点类型"), { target: { value: "agent" } });

    expect(screen.getByLabelText(/plan.*Agent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ id: "plan", kind: "agent" })],
    }));
  });

  it("removes unsupported Agent settings from non-Agent nodes before saving", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "sanitize-agent-settings-workflow",
          name: "清理 Agent 设置",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{
            id: "plan",
            name: "计划",
            kind: "task",
            agent: { promptTemplate: "这个节点不应有 Agent 配置" },
          }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.not.objectContaining({ agent: expect.anything() })],
    }));
  });
});
