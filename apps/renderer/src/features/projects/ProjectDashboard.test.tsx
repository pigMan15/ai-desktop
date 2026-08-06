import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectDashboard } from "./ProjectDashboard";
import type { RunSummaryProjection } from "@workflow-platform/contracts";

afterEach(() => {
  cleanup();
});

it("guides an uninitialized connected workspace through project import", () => {
  const onImport = vi.fn();
  const onSelectDirectory = vi.fn();

  render(
    <ProjectDashboard
      state={{
        connection: "connected",
        workspaceStatus: "uninitialized",
        projectName: "",
        workflowName: "",
        projection: null,
        timeline: [],
        artifacts: [],
        approvals: [],
        gates: [],
        agentJobs: [],
        agentOutput: [],
      }}
      projectPath="G:\\Project\\demo"
      onProjectPathChange={() => undefined}
      onImport={onImport}
      onSelectDirectory={onSelectDirectory}
    />,
  );

  expect(screen.getByText(/没有工作流文件时，导入后请选择已有工作流/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择项目目录" }));
  fireEvent.click(screen.getByRole("button", { name: "导入项目" }));
  expect(onSelectDirectory).toHaveBeenCalledTimes(1);
  expect(onImport).toHaveBeenCalledTimes(1);
});

it("allows an initialized workspace to be logically archived", () => {
  const onArchive = vi.fn();

  render(
    <ProjectDashboard
      state={{
        connection: "connected",
        workspaceStatus: "ready",
        projectName: "demo",
        workflowName: "Demo Workflow",
        projection: null,
        timeline: [],
        artifacts: [],
        approvals: [],
        gates: [],
        agentJobs: [],
        agentOutput: [],
      }}
      projectPath="G:\\Project\\demo"
      onProjectPathChange={() => undefined}
      onImport={() => undefined}
      onArchive={onArchive}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "归档项目" }));

  expect(onArchive).toHaveBeenCalledTimes(1);
});

it("shows the archived project path and allows it to be reimported", () => {
  const onReimport = vi.fn();

  render(
    <ProjectDashboard
      state={{
        connection: "connected",
        workspaceStatus: "ready",
        projectName: "demo",
        workflowName: "Demo Workflow",
        projection: null,
        timeline: [],
        artifacts: [],
        approvals: [],
        gates: [],
        agentJobs: [],
        agentOutput: [],
      }}
      projectPath="G:\\Project\\demo"
      onProjectPathChange={() => undefined}
      onImport={() => undefined}
      archived
      onReimport={onReimport}
    />,
  );

  expect(screen.getAllByText(/项目已归档/).length).toBeGreaterThan(0);
  expect(screen.getByLabelText("项目路径")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新导入项目" }));
  expect(onReimport).toHaveBeenCalledTimes(1);
});

it("uses the bound workflow state in the project summary and keeps the operation message above Git", () => {
  render(
    <ProjectDashboard
      state={{
        connection: "connected",
        workspaceStatus: "ready",
        projectName: "demo",
        workflowName: "未绑定工作流",
        projection: null,
        timeline: [],
        artifacts: [],
        approvals: [],
        gates: [],
        agentJobs: [],
        agentOutput: [],
      }}
      projectPath="G:\\Project\\demo"
      onProjectPathChange={() => undefined}
      onImport={() => undefined}
      workflowBinding={{
        projectId: "project-1",
        workflowId: "release-workflow",
        workflowVersionId: "workflow-version-1",
        actor: {},
        boundAt: "2026-08-04T00:00:00Z",
        workflowBindingStatus: "bound",
      }}
      operationMessage="导入完成：已绑定发布工作流"
      gitPanel={<section aria-label="Git panel">Git panel</section>}
    />,
  );

  expect(screen.getByRole("cell", { name: "已绑定工作流" })).toBeInTheDocument();

  const status = screen.getByRole("status");
  const gitPanel = screen.getByRole("region", { name: "Git panel" });
  expect(Boolean(status.compareDocumentPosition(gitPanel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

function summary(id: string, status: RunSummaryProjection["status"], updatedAt: string): RunSummaryProjection {
  return {
    id,
    projectId: "project-1",
    workflowVersionId: "workflow-version-1",
    workflowName: "Demo Workflow",
    workflowVersion: "1",
    title: id === "run-new" ? "Latest Run" : "Older Run",
    status,
    taskGoal: null,
    currentNodes: [],
    nextNodes: [],
    progress: { total: 1, passed: 0, running: 0, blocked: 0, pending: 1 },
    blocker: null,
    workspace: null,
    activeAgentCount: 0,
    activeDeploymentCount: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

it("renders bounded Run activity and recent Run links without row detail data", () => {
  render(
    <ProjectDashboard
      state={{
        connection: "connected",
        workspaceStatus: "ready",
        projectName: "demo",
        workflowName: "Demo Workflow",
        projection: null,
        timeline: [], artifacts: [], approvals: [], gates: [], agentJobs: [], agentOutput: [],
      }}
      projectPath="G:\\Project\\demo"
      onProjectPathChange={() => undefined}
      onImport={() => undefined}
      activeRunCount={2}
      recentRuns={[summary("run-new", "IN_PROGRESS", "2026-08-06T10:00:00Z"), summary("run-old", "DONE", "2026-08-05T10:00:00Z")]}
      runsHref="#/runs"
    />,
  );

  expect(screen.getByRole("heading", { name: /2.*活动 Run/ })).toBeInTheDocument();
  expect(screen.getByText("Latest Run")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "查看 Run" })[0]).toHaveAttribute("href", "#/runs/run-new");
  expect(screen.getByRole("link", { name: "查看全部 Run" })).toHaveAttribute("href", "#/runs");
});

it("keeps the archived project overview read-only", () => {
  const onArchive = vi.fn();
  render(
    <ProjectDashboard
      state={{ connection: "connected", workspaceStatus: "ready", projectName: "demo", workflowName: "Demo", projection: null, timeline: [], artifacts: [], approvals: [], gates: [], agentJobs: [], agentOutput: [] }}
      projectPath="G:\\Project\\demo"
      onProjectPathChange={() => undefined}
      onImport={() => undefined}
      archived
      onArchive={onArchive}
      activeRunCount={3}
      recentRuns={[summary("run-1", "DONE", "2026-08-01T00:00:00Z")]}
    />,
  );
  expect(screen.getByRole("heading", { name: /3.*活动 Run/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "褰掓。椤圭洰" })).not.toBeInTheDocument();
  expect(onArchive).not.toHaveBeenCalled();
});
