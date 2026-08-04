import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactsPage } from "./ArtifactsPage";

afterEach(cleanup);

describe("ArtifactsPage", () => {
  it("allows an artifact preview to be closed", () => {
    const onClosePreview = vi.fn();
    render(
      <ArtifactsPage
        state={null}
        preview={{
          id: "artifact-1",
          uri: "file:///workspace/plan.md",
          contentHash: "sha256:abc",
          currentHash: "sha256:abc",
          integrity: "verified",
          mediaType: "text/markdown",
          sizeBytes: 12,
          truncated: false,
          content: "Preview content",
        }}
        onClosePreview={onClosePreview}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭产物预览" }));

    expect(onClosePreview).toHaveBeenCalledOnce();
  });

  it("renders artifact provenance, file location, and content hash", () => {
    render(
      <ArtifactsPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [
            {
              id: "artifact-1",
              runId: "run-1",
              type: "plan",
              uri: "file:///G:/Project/demo/docs/plan.md",
              contentHash: "sha256:abc123",
            },
          ],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
      />,
    );

    expect(screen.getByText("plan")).toBeInTheDocument();
    expect(screen.getByText("file:///G:/Project/demo/docs/plan.md")).toBeInTheDocument();
    expect(screen.getByText("sha256:abc123")).toBeInTheDocument();
    expect(
      screen.getByText(
        "集中查看所有 Run 的可追溯产物。已验证的文本产物可批量交给 Codex 或 Claude CLI 合成，结果在知识库中审核和发布。",
      ),
    ).toBeInTheDocument();
  });

  it("requests and renders a Runtime-backed artifact preview with integrity status", () => {
    const onPreviewArtifact = vi.fn();
    render(
      <ArtifactsPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [
            {
              id: "artifact-1",
              runId: "run-1",
              type: "plan",
              uri: "file:///G:/Project/demo/docs/plan.md",
              contentHash: "sha256:abc123",
            },
          ],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        preview={{
          id: "artifact-1",
          uri: "file:///G:/Project/demo/docs/plan.md",
          contentHash: "sha256:abc123",
          currentHash: "sha256:def456",
          integrity: "changed",
          mediaType: "text/markdown",
          sizeBytes: 18,
          truncated: false,
          content: "# 已修改的计划",
        }}
        onPreviewArtifact={onPreviewArtifact}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看内容" }));

    expect(onPreviewArtifact).toHaveBeenCalledWith("run-1", "artifact-1");
    expect(screen.getByText("文件内容已变更")).toBeInTheDocument();
    expect(screen.getByText("# 已修改的计划")).toBeInTheDocument();
  });

  it("shows a line-level comparison for two text artifact previews", () => {
    render(
      <ArtifactsPage
        state={null}
        comparison={{
          before: { id: "artifact-1", content: "计划\n旧步骤\n" },
          after: { id: "artifact-2", content: "计划\n新步骤\n" },
        }}
      />,
    );

    expect(screen.getByLabelText("产物差异内容").textContent).toContain("- 旧步骤");
    expect(screen.getByLabelText("产物差异内容").textContent).toContain("+ 新步骤");
  });

  it("lets the user select two registered artifacts before requesting a comparison", () => {
    const onCompareArtifacts = vi.fn();
    render(
      <ArtifactsPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [
            {
              id: "artifact-1",
              runId: "run-1",
              type: "plan",
              uri: "file:///G:/Project/demo/docs/plan.md",
              contentHash: "sha256:abc123",
            },
            {
              id: "artifact-2",
              runId: "run-1",
              type: "report",
              uri: "file:///G:/Project/demo/docs/report.md",
              contentHash: "sha256:def456",
            },
          ],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        onCompareArtifacts={onCompareArtifacts}
      />,
    );

    fireEvent.change(screen.getByLabelText("基准产物"), { target: { value: "artifact-1" } });
    fireEvent.change(screen.getByLabelText("对比产物"), { target: { value: "artifact-2" } });
    fireEvent.click(screen.getByRole("button", { name: "比较产物" }));

    expect(onCompareArtifacts).toHaveBeenCalledWith("run-1", "artifact-1", "run-1", "artifact-2");
  });

  it("offers Runtime-backed evidence package and report exports", () => {
    const onDownloadEvidencePackage = vi.fn();
    const onDownloadReport = vi.fn();
    render(
      <ArtifactsPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        onDownloadEvidencePackage={onDownloadEvidencePackage}
        onDownloadReport={onDownloadReport}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "下载证据包" }));
    fireEvent.click(screen.getByRole("button", { name: "下载运行报告" }));

    expect(onDownloadEvidencePackage).toHaveBeenCalledOnce();
    expect(onDownloadReport).toHaveBeenCalledOnce();
  });

  it("filters all artifacts by Run and starts repeatable CLI extraction for selected verified artifacts", () => {
    const onStartKnowledgeExtraction = vi.fn();
    render(
      <ArtifactsPage
        state={null}
        runs={[
          { id: "run-1", title: "First Run", status: "DONE", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:01:00Z" },
          { id: "run-2", title: "Second Run", status: "DONE", createdAt: "2026-08-01T00:02:00Z", updatedAt: "2026-08-01T00:03:00Z" },
        ]}
        artifacts={[
          { id: "artifact-1", runId: "run-1", type: "plan", uri: "file:///workspace/plan.md", contentHash: "abc", status: "verified" },
          { id: "artifact-2", runId: "run-2", type: "report", uri: "file:///workspace/report.md", contentHash: "def", status: "verified" },
        ]}
        extractionCountsByArtifactId={{ "artifact-1": 2 }}
        onStartKnowledgeExtraction={onStartKnowledgeExtraction}
      />,
    );

    expect(screen.getByText("已提取 2 次")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Run 筛选"), { target: { value: "run-2" } });
    expect(screen.getByText("report")).toBeInTheDocument();
    expect(screen.queryByText("plan")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("选择产物 artifact-2"));
    fireEvent.change(screen.getByLabelText("CLI 提供商"), { target: { value: "claude" } });
    fireEvent.click(screen.getByRole("button", { name: "开始 CLI 合成" }));

    expect(onStartKnowledgeExtraction).toHaveBeenCalledWith("run-2", ["artifact-2"], "claude");
  });
});
