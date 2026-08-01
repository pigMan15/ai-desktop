import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KnowledgePage } from "./KnowledgePage";

describe("KnowledgePage", () => {
  it("创建候选、审核并发布经批准的知识", () => {
    const onCreate = vi.fn();
    const onReview = vi.fn();
    const onPublish = vi.fn();
    render(
      <KnowledgePage
        candidates={[
          {
            id: "candidate-1",
            title: "Gate 证据规范",
            content: "每个 Gate 必须关联证据。",
            source: "run:run-1",
            status: "approved",
            createdAt: "2026-07-28T00:00:00Z",
          },
        ]}
        runs={[
          {
            id: "run-1",
            title: "旧任务",
            status: "DONE",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:01:00Z",
          },
          {
            id: "run-2",
            title: "知识沉淀任务",
            status: "DONE",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:01:00Z",
          },
        ]}
        activeRunId="run-1"
        onCreate={onCreate}
        onReview={onReview}
        onPublish={onPublish}
      />,
    );

    fireEvent.change(screen.getByLabelText("知识标题"), { target: { value: "终端规范" } });
    fireEvent.change(screen.getByLabelText("知识内容"), { target: { value: "终端输出应保留。" } });
    fireEvent.change(screen.getByLabelText("关联 Run"), { target: { value: "run-2" } });
    fireEvent.click(screen.getByRole("button", { name: "创建候选" }));
    fireEvent.click(screen.getByRole("button", { name: "发布知识" }));

    expect(onCreate).toHaveBeenCalledWith("终端规范", "终端输出应保留。", "run:run-2");
    expect(onPublish).toHaveBeenCalledWith("candidate-1");
    expect(screen.queryByRole("button", { name: "批准候选" })).not.toBeInTheDocument();
    expect(onReview).not.toHaveBeenCalled();
  });

  it("lets users open a published knowledge document replay", () => {
    const onReplay = vi.fn();
    render(
      <KnowledgePage
        candidates={[]}
        documents={[
          {
            id: "document-1",
            candidateId: "candidate-1",
            title: "产物归档规范",
            content: "所有产物必须保留内容哈希。",
            source: "run:run-archive",
            status: "published",
            publishedAt: "2026-07-28T00:00:00Z",
            gitPublicationCount: 0,
            latestGitPublication: null,
          },
        ]}
        onCreate={vi.fn()}
        onReview={vi.fn()}
        onPublish={vi.fn()}
        onReplay={onReplay}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "回放发布记录：产物归档规范" }));

    expect(onReplay).toHaveBeenCalledWith("document-1");
  });

  it("offers Git preview and controlled publishing for a published document", () => {
    const onPreviewGit = vi.fn();
    const onPublishGit = vi.fn();
    render(
      <KnowledgePage
        candidates={[]}
        documents={[
          {
            id: "document-1",
            candidateId: "candidate-1",
            title: "产物归档规范",
            content: "所有产物必须保留内容哈希。",
            source: "run:run-archive",
            status: "published",
            publishedAt: "2026-07-28T00:00:00Z",
            gitPublicationCount: 1,
            latestGitPublication: {
              branch: "main",
              relativePath: ".workflow-platform/knowledge/document-1.md",
              commitHash: "abc1234",
              pushedAt: "2026-07-28T00:01:00Z",
            },
          },
        ]}
        onCreate={vi.fn()}
        onReview={vi.fn()}
        onPublish={vi.fn()}
        gitAvailable
        onPreviewGit={onPreviewGit}
        onPublishGit={onPublishGit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "预览 Git 变更：产物归档规范" }));

    expect(onPreviewGit).toHaveBeenCalledWith("document-1");
    expect(screen.getByText("已推送 1 次")).toBeInTheDocument();
    expect(screen.getByText("main · abc1234")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交并推送知识：产物归档规范" })).not.toBeInTheDocument();
  });

  it("starts a CLI synthesis, shows its diff, records feedback, and publishes only a completed draft", () => {
    const onSynthesize = vi.fn();
    const onFeedback = vi.fn();
    const onPublishSynthesis = vi.fn();
    const { container } = render(
      <KnowledgePage
        candidates={[
          {
            id: "candidate-1",
            title: "部署验收规则",
            content: "部署前必须完成 Gate 审核。",
            source: "run:run-1",
            status: "approved",
            createdAt: "2026-07-28T00:00:00Z",
          },
        ]}
        syntheses={[
          {
            id: "synthesis-1",
            candidateId: "candidate-1",
            provider: "codex",
            status: "COMPLETED",
            prompt: "合成提示",
            summary: "部署前必须完成 Gate 审核并保留回滚证据。",
            error: null,
            feedback: null,
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:01:00Z",
          },
        ]}
        synthesisOutput={[
          {
            id: "synthesis-1:output:1",
            synthesisId: "synthesis-1",
            sequence: 1,
            kind: "message",
            payload: { text: "正在整理部署验收规则。" },
            createdAt: "2026-07-28T00:00:00Z",
          },
        ]}
        onCreate={vi.fn()}
        onReview={vi.fn()}
        onPublish={vi.fn()}
        onSynthesize={onSynthesize}
        onFeedbackSynthesis={onFeedback}
        onPublishSynthesis={onPublishSynthesis}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始 CLI 合成：部署验收规则" }));
    fireEvent.change(screen.getByLabelText("合成反馈：部署验收规则"), {
      target: { value: "补充上线后验证要求。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存合成反馈：部署验收规则" }));
    fireEvent.click(screen.getByRole("button", { name: "发布合成稿：部署验收规则" }));

    expect(onSynthesize).toHaveBeenCalledWith("candidate-1", "codex");
    expect(onFeedback).toHaveBeenCalledWith("synthesis-1", "补充上线后验证要求。");
    expect(onPublishSynthesis).toHaveBeenCalledWith("synthesis-1");
    expect(screen.getByLabelText("合成实时输出：部署验收规则").textContent).toContain("正在整理部署验收规则。");
    expect(screen.getByLabelText("合成差异：部署验收规则").textContent).toContain("+ 部署前必须完成 Gate 审核并保留回滚证据。");
    expect(container.querySelector(".gate-record .gate-record")).toBeNull();
  });
});
