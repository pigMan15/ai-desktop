import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoleAssetSummary } from "../../app/runtimeClient";
import { RoleAssetsPage } from "./RoleAssetsPage";

afterEach(cleanup);

const roles: RoleAssetSummary[] = [{
  id: "developer",
  name: "开发",
  instructions: "实现需求并验证结果。",
  allowedTools: ["read", "write", "test"],
  isBuiltin: false,
  archivedAt: null,
  updatedAt: "2026-08-04T10:00:00Z",
  roleVersionId: "role-version-developer-1",
  version: 1,
}];

function renderPage(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(
    <RoleAssetsPage
      roles={roles}
      onSave={onSave}
      onArchive={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onRestore={vi.fn().mockResolvedValue(undefined)}
      onLoadHistory={vi.fn().mockResolvedValue([])}
      onLoadReferences={vi.fn().mockResolvedValue([])}
    />,
  );
  return onSave;
}

describe("RoleAssetsPage", () => {
  it("keeps a blank editable draft when creating a role repeatedly", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));
    const idInput = screen.getByLabelText("角色 ID") as HTMLInputElement;
    expect(idInput.value).toBe("");
    expect(idInput).not.toBeDisabled();

    fireEvent.change(idInput, { target: { value: "reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));

    await waitFor(() => expect((screen.getByLabelText("角色 ID") as HTMLInputElement).value).toBe(""));
    expect(screen.getByLabelText("角色 ID")).not.toBeDisabled();
  });

  it("locks the persistent ID for an existing role", () => {
    renderPage();

    expect(screen.getByLabelText("角色 ID")).toBeDisabled();
    expect((screen.getByLabelText("角色 ID") as HTMLInputElement).value).toBe("developer");
  });

  it("restores an archived role for future workflow use", async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(
      <RoleAssetsPage
        roles={[{ ...roles[0], archivedAt: "2026-08-04T12:00:00Z" }]}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onArchive={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onRestore={onRestore}
        onLoadHistory={vi.fn().mockResolvedValue([])}
        onLoadReferences={vi.fn().mockResolvedValue([])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "恢复使用" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("developer"));
  });

  it("saves the entered ID and name for a new role", async () => {
    const onSave = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "新建角色" }));
    fireEvent.change(screen.getByLabelText("角色 ID"), { target: { value: "reviewer" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "审查" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "reviewer", name: "审查" })));
  });
});
