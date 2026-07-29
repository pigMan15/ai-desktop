import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { GitWorkspacePanel } from "./GitWorkspacePanel";

it("creates a controlled worktree and requests a fast-forward merge", () => {
  const onCreateWorktree = vi.fn();
  const onMergeBack = vi.fn();

  render(
    <GitWorkspacePanel
      projectPath="G:\\Project\\demo"
      status={{
        rootPath: "G:\\Project\\demo",
        branch: "main",
        detachedHead: false,
        dirty: false,
        changes: [],
      }}
      worktrees={[
        {
          path: "G:\\Project\\demo\\.workflow-platform\\worktrees\\feature-review",
          branch: "feature/review",
          head: "abc123",
          bare: false,
        },
      ]}
      onRefresh={() => undefined}
      onCreateWorktree={onCreateWorktree}
      onRemoveWorktree={() => undefined}
      onMergeBack={onMergeBack}
      onPush={() => undefined}
    />,
  );

  fireEvent.change(screen.getByLabelText("新分支名称"), {
    target: { value: "feature/new-review" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建 Worktree" }));
  fireEvent.click(screen.getByRole("button", { name: "合并 feature/review" }));

  expect(onCreateWorktree).toHaveBeenCalledWith("feature/new-review");
  expect(onMergeBack).toHaveBeenCalledWith("feature/review");
  expect(screen.getByText("当前分支：main")).toBeInTheDocument();
});
