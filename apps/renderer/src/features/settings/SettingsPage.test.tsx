import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("manages model services: edit, set default, delete", async () => {
    const onSaveModelProvider = vi.fn().mockResolvedValue(undefined);
    const onDeleteModelProvider = vi.fn().mockResolvedValue(undefined);
    const onSetDefaultModelProvider = vi.fn().mockResolvedValue(undefined);
    const onTestModelProvider = vi.fn().mockResolvedValue(null);
    render(
      <SettingsPage
        apiBaseUrl="http://127.0.0.1:8765"
        connection="connected"
        onApiBaseUrlChange={vi.fn()}
        onCheckConnection={vi.fn()}
        modelProviders={[
          {
            id: "p1",
            name: "DeepSeek",
            vendor: "deepseek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "********",
            hasApiKey: true,
            model: "deepseek-chat",
            temperature: 0.3,
            maxTokens: null,
            topP: null,
            systemPrompt: "",
            isDefault: true,
            available: true,
            message: "????",
            createdAt: "2026-08-11T00:00:00Z",
            updatedAt: "2026-08-11T00:00:00Z",
          },
          {
            id: "p2",
            name: "OpenAI",
            vendor: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "",
            hasApiKey: false,
            model: "gpt-4o-mini",
            temperature: 0.7,
            maxTokens: 2048,
            topP: 0.9,
            systemPrompt: "",
            isDefault: false,
            available: false,
            message: "?? API Key / ?? / ??",
            createdAt: "2026-08-11T00:00:00Z",
            updatedAt: "2026-08-11T00:00:00Z",
          },
        ]}
        activeModelProviderId="p1"
        onSaveModelProvider={onSaveModelProvider}
        onDeleteModelProvider={onDeleteModelProvider}
        onSetDefaultModelProvider={onSetDefaultModelProvider}
        onTestModelProvider={onTestModelProvider}
      />,
    );

    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
    expect(onSetDefaultModelProvider).toHaveBeenCalledWith("p2");

    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    fireEvent.change(screen.getByLabelText("模型名称"), {
      target: { value: "deepseek-reasoner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(onSaveModelProvider).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ model: "deepseek-reasoner" }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("服务名称")).not.toBeInTheDocument(),
    );

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[1]);
    fireEvent.click(await screen.findByRole("button", { name: "确认删除？" }));
    expect(onDeleteModelProvider).toHaveBeenCalledWith("p2");
  });

  it("creates a new model service and tests the connection from the draft", async () => {
    const onSaveModelProvider = vi.fn().mockResolvedValue(undefined);
    const onTestModelProvider = vi
      .fn()
      .mockResolvedValue({ ok: true, message: "连接成功，模型回复：pong", latencyMs: 120 });
    render(
      <SettingsPage
        apiBaseUrl="http://127.0.0.1:8765"
        connection="connected"
        onApiBaseUrlChange={vi.fn()}
        onCheckConnection={vi.fn()}
        modelProviders={[]}
        activeModelProviderId={null}
        onSaveModelProvider={onSaveModelProvider}
        onTestModelProvider={onTestModelProvider}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("服务名称"), {
      target: { value: "DeepSeek ???" },
    });
    fireEvent.change(screen.getByLabelText("模型厂商"), { target: { value: "deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(onTestModelProvider).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        vendor: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
      }),
    );
    expect(await screen.findByText("连接成功，模型回复：pong")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(onSaveModelProvider).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ name: "DeepSeek ???", vendor: "deepseek" }),
    );
  });
