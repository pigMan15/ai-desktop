import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowViewer } from "./WorkflowViewer";

afterEach(cleanup);

describe("WorkflowViewer", () => {
  it("does not render Run status inside the workflow definition editor", () => {
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

    expect(screen.getByText("正在加载工作流定义...")).toBeInTheDocument();
    expect(screen.queryByText("当前 Run：run-1")).not.toBeInTheDocument();
    expect(screen.queryByText("WAITING_FOR_HUMAN：等待人工审批")).not.toBeInTheDocument();
  });

  it("keeps project Run progress out of the shared workflow canvas", () => {
    render(
      <WorkflowViewer
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "demo",
          workflowName: "Demo Workflow",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [],
            blockingReasons: [],
            revision: "1",
            updatedAt: "2026-08-05T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        workflow={{
          id: "shared-workflow",
          name: "Shared workflow",
          version: "1",
          sourceAdapter: "manual",
          nodes: [{ id: "plan", name: "Plan", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
      />,
    );

    expect(screen.queryByText("Run: RUNNING")).not.toBeInTheDocument();
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

  it("edits the workflow name from the editor", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{ id: "demo-workflow", name: "旧名称", version: "1", sourceAdapter: "manual", nodes: [], edges: [], roles: [], gates: [], policies: {}, metadata: {} }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.change(screen.getByLabelText("工作流名称"), { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({ name: "新名称" }));
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

  it("keeps workflow actions in the canvas toolbar when configuration is open", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "workflow-actions-workflow",
          name: "Workflow actions",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "Plan", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSimulate={vi.fn()}
        onSaveDefinition={vi.fn()}
        onExportWorkflow={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "工作流配置" }));

    expect(screen.getAllByRole("button", { name: "模拟版本" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "保存新版本" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "恢复为新版本" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "导出工作流" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重置草稿" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "节点库" }));
    fireEvent.change(screen.getByLabelText("新节点 ID"), { target: { value: "review" } });
    fireEvent.change(screen.getByLabelText("新节点名称"), { target: { value: "人工审查" } });
    fireEvent.change(screen.getByLabelText("新节点类型"), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: "新增节点" }));

    fireEvent.click(screen.getByRole("button", { name: "连接 plan 到 review" }));
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(screen.getAllByText("人工审查").length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole("button", { name: "选择节点 implement" }));
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

    fireEvent.click(screen.getByRole("button", { name: "选择节点 plan" }));
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

  it("keeps focus while editing an artifact output ID", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "artifact-focus-workflow",
          name: "交付物焦点测试",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{
            id: "plan",
            name: "计划",
            kind: "task",
            artifacts: {
              outputs: [{ id: "plan", name: "计划文档", type: "plan", required: true, path: "plan.md" }],
            },
          }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择节点 plan" }));
    const input = screen.getByLabelText(/plan.*交付物.*规范 ID/) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "plan-a" } });

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("plan-a");
  });

  it("shows the selected node in the inspector", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "canvas-selection-workflow",
          name: "Canvas selection",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "Plan", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
      />,
    );

    expect(screen.queryByLabelText("plan 节点类型")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择节点 plan" }));

    expect(screen.getByLabelText("plan 节点类型")).toBeInTheDocument();
    expect(screen.getByText("人工任务：由操作者完成工作并在 Run 中手动推进节点。")).toBeInTheDocument();
  });

  it("closes the selected node inspector", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "canvas-inspector-close-workflow",
          name: "Canvas inspector close",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "plan", name: "Plan", kind: "task" }],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择节点 plan" }));
    expect(screen.getByLabelText("plan 节点类型")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭节点属性" }));
    expect(screen.queryByLabelText("plan 节点类型")).not.toBeInTheDocument();
  });

  it("adds an edge through the accessible canvas connection control before saving", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "canvas-connection-workflow",
          name: "Canvas connection",
          version: "1",
          sourceAdapter: "harness",
          nodes: [
            { id: "plan", name: "Plan", kind: "task" },
            { id: "review", name: "Review", kind: "approval" },
          ],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接 plan 到 review" }));
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      edges: [expect.objectContaining({ from: "plan", to: "review" })],
    }));
  });

  it("clears agent roleId but retains the legacy node role when changing to a non-agent node", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "clear-agent-config-workflow",
          name: "Clear agent config",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{
            id: "plan",
            name: "Plan",
            kind: "agent",
            role: "legacy-planner",
            agent: { roleId: "planner", promptTemplate: "Draft a plan" },
          }],
          edges: [],
          roles: [{ id: "planner", name: "Planner" }],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择节点 plan" }));
    fireEvent.change(screen.getByLabelText("plan 节点类型"), { target: { value: "task" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    const savedNode = onSaveDefinition.mock.calls[0][0].nodes[0];
    expect(savedNode).toEqual(expect.objectContaining({
      id: "plan",
      kind: "task",
      role: "legacy-planner",
    }));
    expect(savedNode).not.toHaveProperty("agent");
    expect(savedNode).not.toHaveProperty("agent.roleId");
  });

  it("binds Agent nodes only to active global role assets", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "global-role-bindings",
          name: "Global role bindings",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "implement", name: "Implement", kind: "agent", agent: { roleId: "planner" } }],
          edges: [],
          roles: [
            { id: "planner", name: "Planner" },
            { id: "reviewer", name: "Reviewer" },
            { id: "developer", name: "Developer" },
          ],
          gates: [],
          policies: {},
          metadata: {},
        }}
        roleAssets={[{
          id: "architect",
          name: "Architect",
          isBuiltin: false,
          archivedAt: null,
          updatedAt: "2026-08-04T00:00:00Z",
          roleVersionId: "role-version-architect-2",
          version: 2,
        }, {
          id: "retired-developer",
          name: "Retired developer",
          isBuiltin: false,
          archivedAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
          roleVersionId: "role-version-retired-developer-1",
          version: 1,
        }]}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择节点 implement" }));
    const roleSelect = screen.getAllByRole("combobox").find((element) =>
      element.getAttribute("aria-label")?.includes("implement")
      && Array.from((element as HTMLSelectElement).options).some((option) => option.value === ""),
    );

    expect(roleSelect).toBeDefined();
    expect(Array.from((roleSelect as HTMLSelectElement).options, (option) => option.text)).toEqual([
      "未绑定执行角色",
      "Architect",
    ]);

    fireEvent.change(roleSelect as HTMLSelectElement, { target: { value: "architect" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      roles: [expect.objectContaining({ id: "architect", assetVersionId: "role-version-architect-2" })],
      nodes: [expect.objectContaining({
        id: "implement",
        agent: expect.objectContaining({ roleId: "architect" }),
      })],
    }));
  });

  it("edits a platform role and binds it to the selected Agent node", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "role-library-workflow",
          name: "Role library",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "implement", name: "Implement", kind: "agent" }],
          edges: [],
          roles: [{ id: "developer", name: "Developer", instructions: "Implement approved work." }],
          gates: [],
          policies: {},
          metadata: {},
        }}
        roleAssets={[{
          id: "developer",
          name: "Developer",
          instructions: "Implement approved work.",
          isBuiltin: false,
          archivedAt: null,
          updatedAt: "2026-08-04T00:00:00Z",
          roleVersionId: "role-version-developer-1",
          version: 1,
        }]}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "角色库" }));
    fireEvent.change(screen.getByLabelText("角色 developer 的职责与边界"), {
      target: { value: "Implement the approved plan and verify it." },
    });
    fireEvent.click(screen.getByRole("button", { name: "选择节点 implement" }));
    fireEvent.change(screen.getByLabelText("节点 implement 的执行角色"), { target: { value: "developer" } });
    fireEvent.change(screen.getByLabelText("implement Agent 节点模板"), { target: { value: "Implement the endpoint." } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      roles: [expect.objectContaining({
        id: "developer",
        instructions: "Implement approved work.",
        assetVersionId: "role-version-developer-1",
      })],
      nodes: [expect.objectContaining({
        id: "implement",
        agent: expect.objectContaining({ roleId: "developer", promptTemplate: "Implement the endpoint." }),
      })],
    }));
  });

  it("does not delete a role while an Agent node references it", () => {
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "referenced-role-workflow",
          name: "Referenced role",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "implement", name: "Implement", kind: "agent", agent: { roleId: "developer" } }],
          edges: [],
          roles: [{ id: "developer", name: "Developer" }],
          gates: [],
          policies: {},
          metadata: {},
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "角色库" }));
    fireEvent.click(screen.getByRole("button", { name: "删除角色 developer" }));

    expect(screen.getByText("角色仍被节点 implement 使用")).toBeInTheDocument();
  });

  it("imports the Harness reference roles into the workflow draft", () => {
    const onSaveDefinition = vi.fn();
    render(
      <WorkflowViewer
        state={null}
        workflow={{
          id: "harness-role-import",
          name: "Harness roles",
          version: "1",
          sourceAdapter: "generic-yaml",
          nodes: [],
          edges: [],
          roles: [],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onSaveDefinition={onSaveDefinition}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "角色库" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 Harness 参考角色" }));
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({
      roles: expect.arrayContaining([
        expect.objectContaining({ id: "developer", name: "开发" }),
        expect.objectContaining({ id: "verifier", name: "验证" }),
        expect.objectContaining({ id: "knowledge-keeper", name: "知识沉淀" }),
      ]),
    }));
    expect(onSaveDefinition.mock.calls[0][0].roles).toHaveLength(13);
  });
});
