import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactsPage } from "./ArtifactsPage";

afterEach(cleanup);

describe("ArtifactsPage", () => {
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
        "Runtime 保护的产物记录。每次提交都会经过项目路径限制并记录内容哈希，供审批、门禁和审计引用。",
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

    expect(onPreviewArtifact).toHaveBeenCalledWith("artifact-1");
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
              type: "plan",
              uri: "file:///G:/Project/demo/docs/plan.md",
              contentHash: "sha256:abc123",
            },
            {
              id: "artifact-2",
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

    expect(onCompareArtifacts).toHaveBeenCalledWith("artifact-1", "artifact-2");
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
});
