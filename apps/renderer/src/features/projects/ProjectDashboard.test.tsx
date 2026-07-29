import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProjectDashboard } from "./ProjectDashboard";

it("guides an uninitialized connected workspace through project import", () => {
  const onImport = vi.fn();

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
    />,
  );

  expect(screen.getByText(/尚未导入项目/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "导入项目" }));
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
