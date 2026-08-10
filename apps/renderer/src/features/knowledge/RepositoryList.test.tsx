import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoryList } from "./RepositoryList";

afterEach(cleanup);

const repository = {
  id: "repo-1",
  name: "物流知识库",
  rootPath: "D:/knowledge/logistics",
  canonicalRootPath: "D:/knowledge/logistics",
  repositoryIdentity: "identity",
  currentBranch: "main",
  headCommit: "abc",
  defaultWritePolicy: "risk-based" as const,
  autoApplyLowRisk: false,
  status: "RULES_PENDING" as const,
  activeRuleSnapshotId: null,
  revision: "1",
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T00:00:00Z",
  gitStatus: {
    rootPath: "D:/knowledge/logistics",
    commonDir: "D:/knowledge/logistics/.git",
    branch: "main",
    headCommit: "abc",
    dirty: false,
    conflict: false,
    worktreeFingerprint: "fp",
    stagedPaths: [],
    unstagedPaths: [],
  },
  activeRuleSnapshot: null,
  recentChangeSets: [],
  allowedActions: ["discover-rules"],
};

describe("RepositoryList", () => {
  it("loads and lists repositories", async () => {
    const client = {
      listRepositories: vi.fn(async () => [repository]),
      importRepository: vi.fn(),
      removeRepository: vi.fn(),
    };
    render(<RepositoryList client={client as never} onNavigate={vi.fn()} />);
    expect(await screen.findByText("物流知识库")).toBeInTheDocument();
    expect(screen.getByText("RULES_PENDING")).toBeInTheDocument();
    expect(client.listRepositories).toHaveBeenCalledTimes(1);
  });

  it("imports a repository from the form", async () => {
    const client = {
      listRepositories: vi.fn(async () => []),
      importRepository: vi.fn(async () => repository),
      removeRepository: vi.fn(),
    };
    render(<RepositoryList client={client as never} onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("仓库名称"), { target: { value: "新知识库" } });
    fireEvent.change(screen.getByLabelText("仓库根目录"), { target: { value: "C:/kb" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() => {
      expect(client.importRepository).toHaveBeenCalledWith(
        expect.objectContaining({ name: "新知识库", rootPath: "C:/kb", autoApplyLowRisk: false }),
      );
    });
    expect(await screen.findByText("知识库导入成功")).toBeInTheDocument();
  });

  it("removes a repository and reloads", async () => {
    const client = {
      listRepositories: vi.fn(async () => [repository]),
      importRepository: vi.fn(),
      removeRepository: vi.fn(async () => repository),
    };
    render(<RepositoryList client={client as never} onNavigate={vi.fn()} />);
    const removeButtons = await screen.findAllByRole("button", { name: "移除" });
    fireEvent.click(removeButtons[0]);
    await waitFor(() => {
      expect(client.removeRepository).toHaveBeenCalledWith(
        "repo-1",
        expect.objectContaining({ expectedRevision: "1" }),
      );
    });
    expect(client.listRepositories).toHaveBeenCalledTimes(2);
  });
});
