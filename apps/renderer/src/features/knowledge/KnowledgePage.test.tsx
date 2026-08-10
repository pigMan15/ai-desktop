import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgePage } from "./KnowledgePage";

afterEach(() => {
  cleanup();
  delete (window as Window & { workflowRuntime?: unknown }).workflowRuntime;
});

function knowledgeProps() {
  return {
    candidates: [],
    onCreate: vi.fn(),
    onReview: vi.fn(),
    onPublish: vi.fn(),
    apiBaseUrl: "http://127.0.0.1:8765",
  };
}

describe("KnowledgePage", () => {
  it("renders the legacy panel when no client is configured", () => {
    window.location.hash = "#/knowledge";
    render(<KnowledgePage {...knowledgeProps()} apiBaseUrl={undefined} />);
    expect(screen.getByRole("heading", { name: "知识库" })).toBeInTheDocument();
  });

  it("renders the repository workbench when a client is configured", async () => {
    const repository = {
      id: "repo-1",
      name: "物流知识库",
      status: "RULES_PENDING",
      revision: "1",
      gitStatus: { branch: "main", headCommit: "abc", dirty: false, conflict: false, stagedPaths: [], unstagedPaths: [] },
      activeRuleSnapshot: null,
      recentChangeSets: [],
      allowedActions: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [repository] }),
    })));
    window.location.hash = "#/knowledge/repositories";
    render(<KnowledgePage {...knowledgeProps()} />);
    expect(await screen.findByText("物流知识库")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仓库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "示例包" })).toBeInTheDocument();
  });
});
