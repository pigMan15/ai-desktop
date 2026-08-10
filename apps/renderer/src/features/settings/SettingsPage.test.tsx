import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

describe("SettingsPage", () => {
  it("edits project concurrency within the supported one-to-ten range", async () => {
    const onSaveProjectConcurrency = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsPage
        apiBaseUrl="http://127.0.0.1:8765"
        connection="connected"
        onApiBaseUrlChange={vi.fn()}
        onCheckConnection={vi.fn()}
        projectConcurrency={{ maxActiveRuns: 3, maxActiveAgents: 2 }}
        onSaveProjectConcurrency={onSaveProjectConcurrency}
      />,
    );

    fireEvent.change(screen.getByLabelText("活动 Run 上限"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("每 Run 活动 Agent 上限"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并发限制" }));

    expect(onSaveProjectConcurrency).toHaveBeenCalledWith({ maxActiveRuns: 5, maxActiveAgents: 4 });
  });

  it("allows operators to update the Runtime address and trigger a connection check", () => {
    const onApiBaseUrlChange = vi.fn();
    const onCheckConnection = vi.fn();

    render(
      <SettingsPage
        apiBaseUrl="http://127.0.0.1:8765"
        connection="unavailable"
        onApiBaseUrlChange={onApiBaseUrlChange}
        onCheckConnection={onCheckConnection}
      />,
    );

    fireEvent.change(screen.getByLabelText("Runtime API 地址"), {
      target: { value: "http://127.0.0.1:9900" },
    });
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));

    expect(onApiBaseUrlChange).toHaveBeenCalledWith("http://127.0.0.1:9900");
    expect(onCheckConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Runtime 不可用")).toBeInTheDocument();
  });

  it("shows managed Runtime diagnostics and lets the operator restart it", () => {
    const onRestartManagedRuntime = vi.fn();
    const onDownloadDiagnostics = vi.fn();
    const onRefreshProviderDiagnostics = vi.fn();

    render(
      <SettingsPage
        apiBaseUrl="http://127.0.0.1:8765"
        connection="unavailable"
        onApiBaseUrlChange={vi.fn()}
        onCheckConnection={vi.fn()}
        managedRuntime={{
          mode: "managed",
          state: "failed",
          url: "http://127.0.0.1:8765",
          port: 8765,
          pid: 24680,
          lastError: "Runtime process exited",
        }}
        runtimeLogs={[{ level: "error", message: "Runtime process exited", createdAt: "2026-07-28T00:00:00Z" }]}
        providerDiagnostics={[
          {
            id: "codex",
            executable: "codex.cmd",
            available: true,
            path: "C:\\Tools\\codex.cmd",
            version: "1.2.3",
            message: "已检测到 Codex CLI。",
          },
          {
            id: "claude",
            executable: "claude.cmd",
            available: false,
            path: null,
            version: null,
            message: "未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。",
          },
        ]}
        onRestartManagedRuntime={onRestartManagedRuntime}
        onDownloadDiagnostics={onDownloadDiagnostics}
        onRefreshProviderDiagnostics={onRefreshProviderDiagnostics}
      />,
    );

    expect(screen.getByText("受管 Runtime")).toBeInTheDocument();
    expect(screen.getByText("启动失败")).toBeInTheDocument();
    expect(screen.getByText("Runtime process exited")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重启 Runtime" }));
    fireEvent.click(screen.getByRole("button", { name: "下载诊断支持包" }));
    fireEvent.click(screen.getByRole("button", { name: "重新检测 CLI" }));
    expect(screen.getByText("Codex CLI：已检测到 Codex CLI。")).toBeInTheDocument();
    expect(screen.getByText("版本：1.2.3")).toBeInTheDocument();
    expect(screen.getByText("路径：C:\\Tools\\codex.cmd")).toBeInTheDocument();
    expect(
      screen.getByText("Claude Code CLI：未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。"),
    ).toBeInTheDocument();
    expect(onRestartManagedRuntime).toHaveBeenCalledTimes(1);
    expect(onDownloadDiagnostics).toHaveBeenCalledTimes(1);
    expect(onRefreshProviderDiagnostics).toHaveBeenCalledTimes(1);
  });
});
