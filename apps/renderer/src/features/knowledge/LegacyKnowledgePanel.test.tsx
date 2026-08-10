import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegacyKnowledgePanel } from "./LegacyKnowledgePanel";

afterEach(cleanup);

const baseProps = {
  candidates: [],
  documents: [],
  syntheses: [],
  onCreate: vi.fn(),
  onReview: vi.fn(),
  onPublish: vi.fn(),
  onReplay: vi.fn(),
  onPublishGit: vi.fn(),
};

describe("LegacyKnowledgePanel", () => {
  it("renders the legacy knowledge workbench and replays a published document", () => {
    const onReplay = vi.fn();
    render(
      <LegacyKnowledgePanel
        {...baseProps}
        onReplay={onReplay}
        documents={[
          {
            id: "document-1",
            title: "产物归档规范",
            publishedAt: "2026-08-10T00:00:00Z",
            candidateId: "candidate-1",
            content: "内容",
            source: "run:run-1",
            status: "published",
            gitPublicationCount: 0,
            latestGitPublication: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "知识库" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回放发布记录：产物归档规范" }));
    expect(onReplay).toHaveBeenCalledWith("document-1");
  });

  it("submits a Git publication through the legacy flow", () => {
    const onPublishGit = vi.fn();
    render(
      <LegacyKnowledgePanel
        {...baseProps}
        onPublishGit={onPublishGit}
        gitAvailable={true}
        documents={[
          {
            id: "document-1",
            title: "产物归档规范",
            publishedAt: "2026-08-10T00:00:00Z",
            candidateId: "candidate-1",
            content: "内容",
            source: "run:run-1",
            status: "published",
            gitPublicationCount: 0,
            latestGitPublication: null,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交并推送知识：产物归档规范" }));
    expect(onPublishGit).toHaveBeenCalledWith("document-1");
  });
});
