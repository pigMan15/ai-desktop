import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RunProjection } from "@workflow-platform/contracts";
import type { NodeArtifactScan } from "../../app/runtimeClient";
import { RunArtifactScanFeedback } from "./RunArtifactScanFeedback";

afterEach(cleanup);

function projection(): RunProjection {
  return {
    runId: "run-1",
    status: "IN_PROGRESS",
    currentNodeIds: ["implement"],
    nodeStates: { implement: "RUNNING" },
    allowedActions: [],
    blockingReasons: [],
    revision: "1",
    updatedAt: "2026-08-07T00:00:00Z",
  };
}

function scan(overrides: Partial<NodeArtifactScan> = {}): NodeArtifactScan {
  return {
    runId: "run-1",
    nodeId: "implement",
    registered: [],
    unchanged: [],
    missing: [],
    invalid: [],
    projection: projection(),
    ...overrides,
  };
}

describe("RunArtifactScanFeedback", () => {
  it("shows satisfied counts and Runtime completion readiness", () => {
    render(
      <RunArtifactScanFeedback
        state={{
          phase: "success",
          nodeId: "implement",
          result: scan({ registered: ["bundle"], unchanged: ["notes"] }),
        }}
        nodeName="Implement"
        canComplete
        blockers={[]}
        artifactsHref="#/artifacts?projectId=p&runId=r"
      />,
    );

    const status = screen.getByRole("status", { name: "产物检查结果" });
    expect(status).toHaveTextContent("已满足 2/2");
    expect(status).toHaveTextContent("本次提交1");
    expect(status).toHaveTextContent("已存在1");
    expect(status).toHaveTextContent("可以完成当前节点");
    expect(screen.getByRole("link", { name: "查看全部产物" })).toHaveAttribute(
      "href",
      "#/artifacts?projectId=p&runId=r",
    );
  });

  it("lists missing and invalid artifacts and explains why the node cannot advance", () => {
    render(
      <RunArtifactScanFeedback
        state={{
          phase: "success",
          nodeId: "implement",
          result: scan({
            missing: ["notes"],
            invalid: [{ artifactSpecId: "bundle", reason: "outside workspace" }],
          }),
        }}
        nodeName="Implement"
        canComplete={false}
        blockers={[{
          code: "ARTIFACT_REQUIRED",
          message: "Waiting for artifacts",
          nodeId: "implement",
        }]}
        artifactsHref="#/artifacts?projectId=p&runId=r"
      />,
    );

    const status = screen.getByRole("status", { name: "产物检查结果" });
    expect(status).toHaveTextContent("已满足 0/2");
    expect(status).toHaveTextContent("缺失：notes");
    expect(status).toHaveTextContent("bundle：outside workspace");
    expect(status).toHaveTextContent("暂不能进入下一步");
    expect(status).toHaveTextContent("Waiting for artifacts");
  });

  it("shows scanning progress", () => {
    render(
      <RunArtifactScanFeedback
        state={{ phase: "scanning", nodeId: "implement" }}
        nodeName="Implement"
        canComplete={false}
        blockers={[]}
        artifactsHref="#/artifacts"
      />,
    );

    expect(screen.getByRole("status", { name: "产物检查结果" })).toHaveTextContent(
      "正在扫描声明的产物...",
    );
  });

  it("shows scan errors and renders nothing while idle", () => {
    const { rerender } = render(
      <RunArtifactScanFeedback
        state={{ phase: "error", nodeId: "implement", message: "Cannot read output" }}
        nodeName="Implement"
        canComplete={false}
        blockers={[]}
        artifactsHref="#/artifacts"
      />,
    );

    const status = screen.getByRole("status", { name: "产物检查结果" });
    expect(status).toHaveTextContent("产物扫描失败");
    expect(status).toHaveTextContent("Cannot read output");

    rerender(
      <RunArtifactScanFeedback
        state={{ phase: "idle" }}
        nodeName="Implement"
        canComplete={false}
        blockers={[]}
        artifactsHref="#/artifacts"
      />,
    );
    expect(screen.queryByRole("status", { name: "产物检查结果" })).not.toBeInTheDocument();
  });
});
