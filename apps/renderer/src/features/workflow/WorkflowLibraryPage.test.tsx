import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowLibraryItem } from "../../app/runtimeClient";
import { WorkflowLibraryPage } from "./WorkflowLibraryPage";

afterEach(cleanup);

const workflows: WorkflowLibraryItem[] = [
  {
    workflowId: "delivery-template",
    name: "交付流程模板",
    isBuiltin: true,
    archivedAt: null,
    updatedAt: "2026-08-04T10:00:00Z",
    workflowVersionId: "template-version-1",
    currentVersion: "1",
    nodeCount: 4,
    boundProjectCount: 0,
  },
  {
    workflowId: "product-delivery",
    name: "产品交付",
    isBuiltin: false,
    archivedAt: null,
    updatedAt: "2026-08-04T11:00:00Z",
    workflowVersionId: "delivery-version-3",
    currentVersion: "3",
    nodeCount: 6,
    boundProjectCount: 2,
  },
];

describe("WorkflowLibraryPage", () => {
  it("lists saved workflow assets and opens a new workflow draft", () => {
    const onCreate = vi.fn();
    render(
      <WorkflowLibraryPage
        workflows={workflows}
        loading={false}
        error={null}
        onCreate={onCreate}
        onEdit={vi.fn()}
        onCopyTemplate={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "工作流视图" })).toBeInTheDocument();
    expect(screen.getByText("产品交付")).toBeInTheDocument();
    expect(screen.getByText("交付流程模板")).toBeInTheDocument();
    expect(screen.getAllByText("内置模板")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "新建工作流" }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("opens regular workflows for editing and copies templates instead", () => {
    const onEdit = vi.fn();
    const onCopyTemplate = vi.fn();
    render(
      <WorkflowLibraryPage
        workflows={workflows}
        loading={false}
        error={null}
        onCreate={vi.fn()}
        onEdit={onEdit}
        onCopyTemplate={onCopyTemplate}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑 产品交付" }));
    expect(onEdit).toHaveBeenCalledWith(workflows[1]);

    const copyName = screen.getByLabelText("复制交付流程模板后的工作流名称");
    fireEvent.change(copyName, { target: { value: "我的交付流程" } });
    fireEvent.click(screen.getByRole("button", { name: "基于模板新建 交付流程模板" }));
    expect(onCopyTemplate).toHaveBeenCalledWith(workflows[0], "我的交付流程");
    expect(screen.queryByRole("button", { name: "编辑 交付流程模板" })).not.toBeInTheDocument();
  });
});
