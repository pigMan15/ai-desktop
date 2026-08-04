import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunDashboard } from "./RunDashboard";

vi.mock("../terminal/TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, output, writable, onInput, onInterrupt }: {
    ariaLabel: string;
    output: Array<{ sequence: number; data: string }>;
    writable?: boolean;
    onInput?: (data: string) => void | Promise<void>;
    onInterrupt?: () => void;
  }) => (
    <section aria-label={ariaLabel} className="terminal-viewport" data-writable={String(Boolean(writable))}>
      <pre>{output.map((event) => event.data).join("")}</pre>
      <button type="button" onClick={() => onInput?.("继续\r")}>在 Agent 终端回复</button>
      <button type="button" onClick={onInterrupt}>中断 Agent 终端</button>
    </section>
  ),
}));

afterEach(cleanup);

describe("RunDashboard", () => {
  it("在 Runtime 允许人工完成时显示并触发完成当前节点", () => {
    const onCompleteNode = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-complete",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [
              {
                id: "complete:plan",
                label: "完成当前节点",
                eventType: "NODE_COMPLETED",
                nodeId: "plan",
                risk: "low",
              },
            ],
            blockingReasons: [],
            revision: "2",
            updatedAt: "2026-07-30T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        onCompleteNode={onCompleteNode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "完成当前节点" }));

    expect(onCompleteNode).toHaveBeenCalledWith("plan");
  });

  it("引导未初始化工作区先导入项目，而不是展示 Run 操作", () => {
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "uninitialized",
          projectName: "未导入",
          workflowName: "未导入",
          projection: null,
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
      />,
    );

    expect(screen.getByText("请先在项目工作区导入一个项目，再创建和管理 Run。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往项目工作区" })).toHaveAttribute("href", "#/projects");
    expect(screen.queryByRole("button", { name: "启动节点" })).not.toBeInTheDocument();
  });

  it("在已导入项目但尚未创建 Run 时提供创建表单", () => {
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
      />,
    );

    expect(screen.getByLabelText("Run 名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建 Run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "启动节点" })).not.toBeInTheDocument();
  });

  it("blocks Run creation until the imported project binds a workflow", () => {
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "未绑定工作流",
          projection: null,
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        workflowBinding={null}
      />,
    );

    expect(screen.getByText("请先为项目选择并绑定工作流，再创建 Run。"))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去选择工作流" })).toHaveAttribute("href", "#/projects");
    expect(screen.queryByRole("button", { name: "创建 Run" })).not.toBeInTheDocument();
  });

  it("将任务目标和结构化运行参数随 Run 一起提交", () => {
    const onCreateRun = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        onCreateRun={onCreateRun}
      />,
    );

    fireEvent.change(screen.getByLabelText("Run 名称"), { target: { value: "生产发布准备" } });
    fireEvent.change(screen.getByLabelText("任务目标"), {
      target: { value: "验证发布流程并生成可审计报告" },
    });
    fireEvent.change(screen.getByLabelText("运行参数（JSON 对象）"), {
      target: { value: "{\"dryRun\":true,\"region\":\"cn-north-1\"}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));

    expect(onCreateRun).toHaveBeenCalledWith("生产发布准备", {
      taskGoal: "验证发布流程并生成可审计报告",
      parameters: { dryRun: true, region: "cn-north-1" },
    });
  });

  it("displays persisted Runs and switches the active Run through the supplied callback", () => {
    const onSelectRun = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-2",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [],
            blockingReasons: [],
            revision: "1",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        runs={[
          {
            id: "run-1",
            title: "第一个并发 Run",
            status: "CREATED",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          {
            id: "run-2",
            title: "第二个并发 Run",
            status: "IN_PROGRESS",
            createdAt: "2026-07-28T00:01:00Z",
            updatedAt: "2026-07-28T00:01:00Z",
          },
        ]}
        activeRunId="run-2"
        onSelectRun={onSelectRun}
      />,
    );

    expect(screen.getByLabelText("切换 Run")).toHaveValue("run-2");
    fireEvent.change(screen.getByLabelText("切换 Run"), { target: { value: "run-1" } });

    expect(onSelectRun).toHaveBeenCalledWith("run-1");
    expect(screen.getByText("第一个并发 Run（CREATED）")).toBeInTheDocument();
  });

  it("switches the selected node to the next active node after completion", () => {
    const initialState = {
      connection: "connected" as const,
      workspaceStatus: "ready" as const,
      projectName: "Demo",
      workflowName: "Demo workflow",
      timeline: [],
      artifacts: [],
      approvals: [],
      gates: [],
      agentJobs: [],
      agentOutput: [],
    };
    const { rerender } = render(
      <RunDashboard
        state={{
          ...initialState,
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING", implement: "PENDING" },
            allowedActions: [],
            blockingReasons: [],
            revision: "1",
            updatedAt: "2026-08-02T00:00:00Z",
          },
        }}
      />,
    );

    rerender(
      <RunDashboard
        state={{
          ...initialState,
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["implement"],
            nodeStates: { plan: "PASSED", implement: "READY" },
            allowedActions: [],
            blockingReasons: [],
            revision: "2",
            updatedAt: "2026-08-02T00:01:00Z",
          },
        }}
      />,
    );

    expect(screen.getByLabelText("节点 ID")).toHaveValue("implement");
  });

  it("展示 CLI Provider 检测结果并禁用不可用的选项", () => {
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [],
            blockingReasons: [],
            revision: "1",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        providerDiagnostics={[
          {
            id: "codex",
            executable: "codex.cmd",
            available: true,
            path: "C:\\Tools\\codex.cmd",
            version: "1.0.0",
            message: "已检测到 Codex CLI。",
          },
          {
            id: "claude",
            executable: "claude.cmd",
            available: false,
            path: null,
            version: null,
            message: "未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText("CLI Provider 状态").textContent).toContain("已检测到 Codex CLI。");
    expect(screen.getByLabelText("CLI Provider 状态").textContent).toContain(
      "未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。",
    );
    expect(screen.getByRole("option", { name: "Claude Code CLI（不可用）" })).toBeDisabled();
  });

  it("要求填写理由后才能提交 Gate 豁免", () => {
    const onWaiveGate = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "REVIEWING",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "AWAITING_GATE" },
            allowedActions: [
              {
                id: "gate-waive:plan",
                label: "Waive gate",
                eventType: "GATE_WAIVED",
                nodeId: "plan",
                risk: "high",
              },
            ],
            blockingReasons: [],
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
        onWaiveGate={onWaiveGate}
      />,
    );

    const waiveButton = screen.getByRole("button", { name: "豁免 Gate" });
    expect(waiveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("豁免理由"), {
      target: { value: "上线窗口紧急，已获得授权" },
    });
    fireEvent.click(waiveButton);

    expect(onWaiveGate).toHaveBeenCalledWith("plan", "上线窗口紧急，已获得授权");
  });

  it("renders Kernel-authorized Run pause and resume controls", () => {
    const { rerender } = render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [
              {
                id: "run-pause",
                label: "Pause run",
                eventType: "RUN_PAUSED",
                risk: "medium",
              },
            ],
            blockingReasons: [],
            revision: "1",
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

    expect(screen.getByRole("button", { name: "暂停 Run" })).toBeEnabled();

    rerender(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "PAUSED",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [
              {
                id: "run-resume",
                label: "Resume run",
                eventType: "RUN_RESUMED",
                risk: "medium",
              },
            ],
            blockingReasons: [],
            revision: "2",
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

    expect(screen.getByRole("button", { name: "恢复 Run" })).toBeEnabled();
  });

  it("shows governed deployments with output and exposes start and cancel callbacks", () => {
    const onStartDeployment = vi.fn();
    const onCancelDeployment = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["deploy"],
            nodeStates: { deploy: "READY" },
            allowedActions: [
              {
                id: "start:deploy",
                label: "Start node",
                eventType: "NODE_STARTED",
                nodeId: "deploy",
                risk: "low",
              },
            ],
            blockingReasons: [],
            revision: "7",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        deployments={[
          {
            id: "deployment-1",
            runId: "run-1",
            nodeId: "deploy",
            command: ["npm", "run", "deploy"],
            cwd: "G:\\Project\\demo",
            status: "RUNNING",
            pid: 1234,
            summary: null,
            error: null,
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:01Z",
          },
        ]}
        deploymentOutput={[
          {
            id: "deployment-1:output:1",
            deploymentId: "deployment-1",
            sequence: 1,
            data: "部署日志：正在发布\r\n",
            createdAt: "2026-07-28T00:00:01Z",
          },
        ]}
        onStartDeployment={onStartDeployment}
        onCancelDeployment={onCancelDeployment}
      />,
    );

    fireEvent.change(screen.getByLabelText("节点 ID"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "启动部署" }));
    fireEvent.click(screen.getByRole("button", { name: "取消部署：deployment-1" }));

    expect(onStartDeployment).toHaveBeenCalledWith("deploy");
    expect(onCancelDeployment).toHaveBeenCalledWith("deployment-1");
    expect(screen.getByLabelText("部署实时输出").textContent).toContain("部署日志：正在发布");
  });

  it("默认以交互模式启动 Agent，并在 xterm 中直接回复运行中的 Agent", () => {
    const onStartAgent = vi.fn();
    const onAgentTerminalInput = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "RUNNING" },
            allowedActions: [],
            blockingReasons: [],
            revision: "1",
            updatedAt: "2026-07-29T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [
            {
              id: "job-1",
              runId: "run-1",
              nodeId: "plan",
              provider: "codex",
              mode: "interactive",
              status: "RUNNING",
              command: ["codex.cmd"],
              cwd: "G:\\Project\\demo",
              pid: 1234,
              sessionId: "agent-session-1",
              summary: null,
              error: null,
              createdAt: "2026-07-29T00:00:00Z",
              updatedAt: "2026-07-29T00:00:00Z",
            },
          ],
          agentOutput: [
            {
              id: "out-1",
              jobId: "job-1",
              sequence: 1,
              kind: "terminal_raw",
              payload: { text: "需要你回复 yes/no\r\n" },
              createdAt: "2026-07-29T00:00:01Z",
            },
          ],
        }}
        onStartAgent={onStartAgent}
        onAgentTerminalInput={onAgentTerminalInput}
      />,
    );

    fireEvent.change(screen.getByLabelText("Agent 提示词"), { target: { value: "继续开发" } });
    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
    expect(onStartAgent).toHaveBeenCalledWith("plan", "codex", "继续开发", "interactive", [], undefined);

    expect(screen.getByLabelText("Agent 交互终端")).toHaveAttribute("data-writable", "true");
    expect(screen.getByLabelText("Agent 交互终端").textContent).toContain("需要你回复 yes/no");
    fireEvent.click(screen.getByRole("button", { name: "在 Agent 终端回复" }));
    expect(onAgentTerminalInput).toHaveBeenCalledWith("job-1", "继续\r");
  });

  it("uses the selected node role defaults when starting an Agent", () => {
    const onStartAgent = vi.fn();
    render(
      <RunDashboard
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "demo",
          workflowName: "Demo Workflow",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["implement"],
            nodeStates: { implement: "RUNNING" },
            allowedActions: [],
            blockingReasons: [],
            revision: "1",
            updatedAt: "2026-08-01T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        workflow={{
          id: "role-defaults-workflow",
          name: "Role defaults",
          version: "1",
          sourceAdapter: "harness",
          nodes: [{ id: "implement", name: "Implement", kind: "agent", agent: { roleId: "developer" } }],
          edges: [],
          roles: [{ id: "developer", name: "Developer", provider: "claude", allowedTools: ["read", "edit", "test"] }],
          gates: [],
          policies: {},
          metadata: {},
        }}
        onStartAgent={onStartAgent}
        agentWorkspaces={[
          { path: "G:\\Project\\demo", label: "main（主工作区）" },
          { path: "G:\\Project\\demo\\.workflow-platform\\worktrees\\dev", label: "dev（Worktree）" },
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Agent 提示词"), { target: { value: "Implement the endpoint" } });
    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));

    expect(onStartAgent).toHaveBeenCalledWith(
      "implement",
      "claude",
      "Implement the endpoint",
      "interactive",
      ["read", "edit", "test"],
      "G:\\Project\\demo\\.workflow-platform\\worktrees\\dev",
    );
  });
});
