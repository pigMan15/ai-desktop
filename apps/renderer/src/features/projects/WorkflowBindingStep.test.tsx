import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { WorkflowLibraryItem } from "../../app/runtimeClient";
import { WorkflowBindingStep } from "./WorkflowBindingStep";

afterEach(cleanup);

const workflows: WorkflowLibraryItem[] = [
  {
    workflowId: "workflow-custom",
    workflowVersionId: "workflow-version-custom",
    name: "支付改造",
    isBuiltin: false,
    archivedAt: null,
    updatedAt: "2026-08-04T08:00:00Z",
    currentVersion: "v3",
    nodeCount: 5,
    boundProjectCount: 1,
  },
  {
    workflowId: "workflow-template",
    workflowVersionId: "workflow-version-template",
    name: "研发交付模板",
    isBuiltin: true,
    archivedAt: null,
    updatedAt: "2026-08-04T08:00:00Z",
    currentVersion: "v1",
    nodeCount: 4,
    boundProjectCount: 0,
  },
];

it("allows an unbound project to bind an existing workflow version", () => {
  const onBind = vi.fn();
  render(
    <WorkflowBindingStep
      projectId="project-demo"
      workflows={workflows}
      binding={null}
      onBind={onBind}
      onCopyTemplate={vi.fn()}
      onCreateBusinessWorkflow={vi.fn()}
    />,
  );

  expect(screen.getByRole("heading", { name: "选择工作流" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "绑定支付改造" }));
  expect(onBind).toHaveBeenCalledWith("workflow-custom", "workflow-version-custom");
});

it("copies a template before binding and can open business workflow creation", () => {
  const onCopyTemplate = vi.fn();
  const onCreateBusinessWorkflow = vi.fn();
  render(
    <WorkflowBindingStep
      projectId="project-demo"
      workflows={workflows}
      binding={null}
      onBind={vi.fn()}
      onCopyTemplate={onCopyTemplate}
      onCreateBusinessWorkflow={onCreateBusinessWorkflow}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "基于研发交付模板新建并绑定" }));
  expect(onCopyTemplate).toHaveBeenCalledWith(workflows[1]);
  fireEvent.click(screen.getByRole("button", { name: "新建业务工作流" }));
  expect(onCreateBusinessWorkflow).toHaveBeenCalledTimes(1);
});
