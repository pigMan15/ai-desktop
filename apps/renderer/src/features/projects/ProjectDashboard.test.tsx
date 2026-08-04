import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectDashboard } from "./ProjectDashboard";

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

  expect(screen.getByText(/项目已归档/)).toBeInTheDocument();
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
