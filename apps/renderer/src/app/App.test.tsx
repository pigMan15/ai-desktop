import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const navLabels = [
  "Projects",
  "Runs",
  "Workflow",
  "Terminal",
  "Gates",
  "Artifacts",
  "Approvals",
  "Recovery",
  "Settings",
];

describe("App", () => {
  it("lets operators drive the Runtime API from Chinese controls", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path: url.pathname + url.search, body });

        if (url.pathname === "/health") {
          return jsonResponse({ status: "ok" });
        }
        if (url.pathname === "/projects/import") {
          return jsonResponse({
            projectId: "project-demo",
            workflowVersionId: "workflow-version-demo",
            workflowName: "Demo Workflow",
          });
        }
        if (url.pathname === "/runs") {
          return jsonResponse(projection("run-demo", "1", "CREATED"));
        }
        if (url.pathname === "/runs/run-demo/transition") {
          return jsonResponse(projection("run-demo", "2", "IN_PROGRESS"));
        }
        if (url.pathname === "/runs/run-demo/artifacts" && init?.method === "POST") {
          return jsonResponse(projection("run-demo", "3", "REVIEWING"));
        }
        if (url.pathname === "/runs/run-demo/approvals/plan/decide") {
          return jsonResponse(projection("run-demo", "4", "REVIEWING"));
        }
        if (url.pathname === "/runs/run-demo/gates" && init?.method === "POST") {
          return jsonResponse(projection("run-demo", "5", "IN_PROGRESS"));
        }
        if (url.pathname === "/runs/run-demo/timeline") {
          return jsonResponse([{ id: "event-1", type: "GATE_PASSED", nodeId: "plan", createdAt: "2026-07-28T00:00:00Z" }]);
        }
        if (url.pathname === "/runs/run-demo/projection") {
          return jsonResponse(projection("run-demo", "5", "IN_PROGRESS"));
        }
        if (url.pathname === "/runs/run-demo/artifacts" && init?.method === "GET") {
          return jsonResponse([{ id: "artifact-1", type: "plan", uri: "file:///plan.md", contentHash: "sha256:test" }]);
        }
        if (url.pathname === "/runs/run-demo/approvals") {
          return jsonResponse([{ id: "approval-1", status: "approved", comment: "中文审批" }]);
        }
        if (url.pathname === "/runs/run-demo/gates" && init?.method === "GET") {
          return jsonResponse([{ id: "gate-1", status: "passed", evidence: ["file:///plan.md"] }]);
        }
        if (url.pathname === "/runs/run-demo/agents") {
          return jsonResponse({
            id: "job-1",
            runId: "run-demo",
            nodeId: "plan",
            provider: "fake",
            status: "COMPLETED",
            command: ["fake-cli"],
            cwd: "G:\\Project\\demo",
            summary: "Agent 完成",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:00Z",
          });
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/output") {
          return jsonResponse([{ id: "out-1", jobId: "job-1", sequence: 1, kind: "message", payload: { text: "Agent 日志" }, createdAt: "2026-07-28T00:00:00Z" }]);
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/cancel") {
          return jsonResponse({ id: "job-1", status: "CANCELLED" });
        }

        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Runtime API 地址"), {
      target: { value: "http://127.0.0.1:8765" },
    });
    fireEvent.change(screen.getByLabelText("项目路径"), {
      target: { value: "G:\\Project\\demo" },
    });
    fireEvent.change(screen.getByLabelText("Artifact 路径"), {
      target: { value: "G:\\Project\\demo\\plan.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入项目" }));
    expect(await screen.findByText("导入完成：Demo Workflow")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByText("Run 已创建：run-demo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启动节点" }));
    fireEvent.click(await screen.findByRole("button", { name: "提交 Artifact" }));
    fireEvent.click(await screen.findByRole("button", { name: "人工批准" }));
    fireEvent.click(await screen.findByRole("button", { name: "通过 Gate" }));
    expect(await screen.findByText("GATE_PASSED：plan")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Agent 提示词"), {
      target: { value: "请用中文开发剩余内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
    expect(await screen.findByText("Agent 日志")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消 Agent" }));
    expect(await screen.findByText("Agent 已取消：job-1")).toBeInTheDocument();

    expect(calls.map((call) => call.path)).toContain("/runs/run-demo/agents/job-1/cancel");
  });

  it("renders Runtime-backed P1 state and actions", async () => {
    render(<App />);

    expect(await screen.findByText("Runtime API 不可用")).toBeInTheDocument();
    expect(screen.getByText("demo-workflow")).toBeInTheDocument();
    expect(screen.getByText("AWAITING_APPROVAL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交 Artifact" })).toBeDisabled();
    expect(screen.getByText("artifact://plan.md")).toBeInTheDocument();
  });

  it("renders the MVP workbench navigation", () => {
    render(<App />);

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    for (const label of navLabels) {
      expect(within(navigation).getByText(label)).toBeInTheDocument();
    }
  });

  it("renders a status-oriented workbench as the first screen", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Renderer UI MVP 工作台" })).toBeInTheDocument();
    expect(screen.getAllByText("当前 Run 状态").length).toBeGreaterThan(0);
    expect((await screen.findAllByText("REVIEWING")).length).toBeGreaterThan(0);
    expect(screen.getByText("WAITING_FOR_HUMAN：等待人工审批")).toBeInTheDocument();
    expect(screen.queryByText("AI Workflow Platform")).not.toBeInTheDocument();
  });

  it("covers all Task 11 pages with Chinese domain context", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Project Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText(/Renderer 展示 Runtime 返回的项目/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Run Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/展示 Runtime projection 中的 run 状态/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workflow Viewer" })).toBeInTheDocument();
    expect(screen.getByText(/只读呈现节点、依赖和等待中的 gate/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByText(/终端输出等待 Runtime 会话接入/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Approval Inbox" })).toBeInTheDocument();
    expect(screen.getByText(/审批项需要 Runtime allowedActions 才能处理/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Gates" })).toBeInTheDocument();
    expect(screen.getByText(/gate 状态来自 Runtime projection/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument();
    expect(screen.getByText(/证据与产物索引来自 Runtime artifact guard/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeInTheDocument();
    expect(screen.getByText(/projection rebuild 入口/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText(/设置项当前仅展示目标配置面/)).toBeInTheDocument();
  });

  it("keeps interactive actions disabled until Runtime state exists", async () => {
    render(<App />);

    await screen.findByText("Runtime API 不可用");
    expect(screen.queryByRole("button", { name: /完成节点/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交 Artifact" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "人工批准" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "通过 Gate" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "等待 Runtime allowedActions" })).toHaveLength(2);
  });
});

function projection(runId: string, revision: string, status: "CREATED" | "IN_PROGRESS" | "REVIEWING") {
  return {
    runId,
    status,
    currentNodeIds: ["plan"],
    nodeStates: { plan: "AWAITING_ARTIFACT" },
    allowedActions: [
      { id: "submit-artifact", label: "提交 Artifact", eventType: "ARTIFACT_SUBMITTED", nodeId: "plan", risk: "medium" },
      { id: "approve", label: "人工批准", eventType: "HUMAN_APPROVED", nodeId: "plan", risk: "medium" },
      { id: "pass-gate", label: "通过 Gate", eventType: "GATE_PASSED", nodeId: "plan", risk: "medium" },
    ],
    blockingReasons: [{ code: "WAITING_FOR_ARTIFACT", message: "等待产物", nodeId: "plan" }],
    revision,
    updatedAt: "2026-07-28T00:00:00Z",
  };
}

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}
