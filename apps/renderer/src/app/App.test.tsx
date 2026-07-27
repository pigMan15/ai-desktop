import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";

afterEach(() => {
  cleanup();
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
  it("renders the MVP workbench navigation", () => {
    render(<App />);

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    for (const label of navLabels) {
      expect(within(navigation).getByText(label)).toBeInTheDocument();
    }
  });

  it("renders a status-oriented workbench as the first screen", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Renderer UI MVP 工作台" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("当前 Run 状态").length).toBeGreaterThan(0);
    expect(screen.getByText("允许操作")).toBeInTheDocument();
    expect(screen.queryByText("AI Workflow Platform")).not.toBeInTheDocument();
  });

  it("covers all Task 11 pages with Chinese domain context", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Project Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/项目导入已接入 Runtime API 路径/)).toBeInTheDocument();
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
    expect(screen.getByText(/恢复建议需要后端快照和审计记录/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText(/设置项当前仅展示目标配置面/)).toBeInTheDocument();
  });

  it("does not expose local completion, approval, or gate-pass actions", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: /完成节点|批准|通过 gate/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /等待 Runtime allowedActions/ })).toHaveLength(3);
  });
});
