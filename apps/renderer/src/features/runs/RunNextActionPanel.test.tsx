import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunProjection } from "@workflow-platform/contracts";
import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";
import type { RunGuidance, RunGuidanceAction } from "./runWorkbenchModel";
import { resolveNodeGuidance } from "./runWorkbenchModel";
import { RunNextActionPanel } from "./RunNextActionPanel";

afterEach(cleanup);

function action(
  eventType: RunGuidanceAction["eventType"],
  label: string,
  result: string,
  priority: RunGuidanceAction["priority"],
  requiredInput: RunGuidanceAction["requiredInput"] = "none",
): RunGuidanceAction {
  const allowedAction = {
    id: `${eventType.toLowerCase()}-action`,
    eventType,
    nodeId: "approval",
    risk: "medium" as const,
    label,
  };

  return {
    ...allowedAction,
    label,
    result,
    priority,
    requiredInput,
    allowedAction,
  };
}

function guidance(overrides: Partial<RunGuidance> = {}): RunGuidance {
  return {
    node: null,
    runStatus: "REVIEWING",
    readOnly: false,
    actions: [],
    primaryAction: null,
    secondaryActions: [],
    blockingReason: null,
    waitingMessage: null,
    ...overrides,
  };
}

const approveAction = action(
  "HUMAN_APPROVED",
  "批准方案，进入开发实现",
  "批准后，运行将进入开发实现。",
  "primary",
);
const rejectAction = action(
  "HUMAN_REJECTED",
  "驳回方案",
  "驳回后，方案将退回修改。",
  "secondary",
);
const deferAction = action(
  "HUMAN_DEFERRED",
  "暂缓决策",
  "运行将继续等待审批决定。",
  "secondary",
);
const approvalGuidance = guidance({
  actions: [approveAction, rejectAction, deferAction],
  primaryAction: approveAction,
  secondaryActions: [rejectAction, deferAction],
});

function workflow(): WorkflowDefinitionSummary {
  return {
    id: "release-workflow",
    name: "Release workflow",
    version: "1",
    sourceAdapter: "harness",
    nodes: [{ id: "approval", name: "Approval", kind: "approval" }],
    edges: [],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
  };
}

function projection(overrides: Partial<RunProjection> = {}): RunProjection {
  return {
    runId: "run-1",
    status: "REVIEWING",
    currentNodeIds: ["approval"],
    nodeStates: { approval: "AWAITING_APPROVAL" },
    allowedActions: [],
    blockingReasons: [],
    revision: "1",
    updatedAt: "2026-08-04T00:00:00Z",
    ...overrides,
  };
}

describe("RunNextActionPanel", () => {
  it("按 resolver 输出渲染 primary 和 secondary，不添加未授权事件", () => {
    const resolvedGuidance = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        allowedActions: [
          {
            id: "approve-approval",
            label: "Approve",
            eventType: "HUMAN_APPROVED",
            nodeId: "approval",
            risk: "medium",
          },
          {
            id: "reject-approval",
            label: "Reject",
            eventType: "HUMAN_REJECTED",
            nodeId: "approval",
            risk: "medium",
          },
        ],
      }),
      nodeId: "approval",
      projectArchived: false,
    });
    render(<RunNextActionPanel guidance={resolvedGuidance} onAction={vi.fn()} />);

    const panel = screen.getByRole("region", { name: "下一步操作" });
    const renderedButtons = within(panel).getAllByRole("button");
    const renderedActionIds = renderedButtons.map((button) => button.getAttribute("data-action-id"));
    const expectedActionIds = [
      resolvedGuidance.primaryAction,
      ...resolvedGuidance.secondaryActions,
    ].map((action) => action?.id);

    expect(renderedActionIds).toEqual(expectedActionIds);
    expect(renderedActionIds).not.toContain("archive-approval");
    expect(within(panel).queryByRole("button", { name: "归档运行" })).not.toBeInTheDocument();
    expect(renderedButtons.every((button) =>
      resolvedGuidance.actions.some((action) => action.id === button.getAttribute("data-action-id")),
    )).toBe(true);
  });

  it("点击操作时转发完整的 RunGuidanceAction", () => {
    const onAction = vi.fn();
    render(<RunNextActionPanel guidance={approvalGuidance} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: approveAction.label }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(approveAction);
  });

  it("在等待阻塞产物时显示 guidance 提供的具体原因", () => {
    render(
      <RunNextActionPanel
        guidance={guidance({
          runStatus: "BLOCKED",
          blockingReason: {
            code: "ARTIFACT_REQUIRED",
            message: "等待交付物：plan.md",
            nodeId: "planning",
          },
          waitingMessage: "等待交付物：plan.md",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("等待交付物：plan.md")).toBeInTheDocument();
  });

  it("在 waitingMessage 缺失时回退到 blockingReason.message", () => {
    render(
      <RunNextActionPanel
        guidance={guidance({
          blockingReason: {
            code: "ARTIFACT_REQUIRED",
            message: "等待交付物：plan.md",
            nodeId: "planning",
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("等待交付物：plan.md")).toBeInTheDocument();
  });

  it("在两种等待文案都缺失时显示默认无操作消息", () => {
    render(<RunNextActionPanel guidance={guidance()} onAction={vi.fn()} />);

    expect(screen.getByText("当前没有可执行操作。")).toBeInTheDocument();
  });

  it("归档只读状态不渲染命令按钮", () => {
    render(
      <RunNextActionPanel
        guidance={guidance({
          actions: [approveAction, rejectAction],
          primaryAction: approveAction,
          secondaryActions: [rejectAction],
          runStatus: "ARCHIVED",
          readOnly: true,
          waitingMessage: "项目已归档，运行仅可查看。",
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("项目已归档，运行仅可查看。")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("将一个主要操作及其结果与次要操作分层呈现", () => {
    render(<RunNextActionPanel guidance={approvalGuidance} onAction={vi.fn()} />);

    const primary = screen.getByTestId("run-next-action-primary");
    const secondary = screen.getByTestId("run-next-action-secondary");

    expect(within(primary).getByRole("button", { name: approveAction.label })).toHaveClass("run-next-action-primary-button");
    expect(within(primary).getByText(approveAction.result)).toHaveClass("run-next-action-result");
    expect(within(secondary).getByRole("button", { name: rejectAction.label })).toHaveClass("run-next-action-secondary-button");
    expect(within(secondary).getByRole("button", { name: deferAction.label })).toHaveClass("run-next-action-secondary-button");
  });

  it("只为需要输入的 artifact、evidence、waiver 操作调用并渲染输入", () => {
    const artifactAction = action(
      "ARTIFACT_SUBMITTED",
      "提交产物",
      "提交产物。",
      "primary",
      "artifact",
    );
    const evidenceAction = action(
      "GATE_PASSED",
      "通过关卡",
      "记录关卡证据。",
      "secondary",
      "gate-evidence",
    );
    const waiverAction = action(
      "GATE_WAIVED",
      "豁免关卡",
      "记录豁免理由。",
      "secondary",
      "waiver-reason",
    );
    const renderInput = vi.fn((actionToRender: RunGuidanceAction) => (
      <input aria-label={`${actionToRender.id} 输入`} />
    ));

    render(
      <RunNextActionPanel
        guidance={guidance({
          actions: [approveAction, artifactAction, evidenceAction, waiverAction],
          primaryAction: artifactAction,
          secondaryActions: [approveAction, evidenceAction, waiverAction],
        })}
        onAction={vi.fn()}
        renderInput={renderInput}
      />,
    );

    expect(renderInput).toHaveBeenCalledTimes(3);
    expect(renderInput).toHaveBeenCalledWith(artifactAction);
    expect(renderInput).toHaveBeenCalledWith(evidenceAction);
    expect(renderInput).toHaveBeenCalledWith(waiverAction);
    expect(renderInput).not.toHaveBeenCalledWith(approveAction);
    expect(screen.getByRole("textbox", { name: `${artifactAction.id} 输入` })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: `${evidenceAction.id} 输入` })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: `${waiverAction.id} 输入` })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: `${approveAction.id} 输入` })).not.toBeInTheDocument();
  });
});
