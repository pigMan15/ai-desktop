import { _electron as electron, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const installedDesktopExecutable = process.env.INSTALLED_DESKTOP_EXE;
const installedRealProviderExecutable = process.env.INSTALLED_REAL_PROVIDER_EXE;
const installedRuntimePort = 8879;
const installedTerminalRuntimePort = 8882;
const installedProviderRuntimePort = 8884;
const installedTerminalApprovalRuntimePort = 8886;
const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");

async function writeTerminalCommand(window: Page, command: string): Promise<void> {
  await window.getByLabel("ANSI 终端", { exact: true }).click();
  await window.keyboard.type(command);
  await window.keyboard.press("Enter");
}

test.skip(!installedDesktopExecutable, "需要通过 INSTALLED_DESKTOP_EXE 指定已安装程序。");

test("已安装桌面 EXE 从安装目录加载应用资源并启动受管 Runtime", async () => {
  const app = await electron.launch({
    executablePath: installedDesktopExecutable!,
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(installedRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.resolve(".workflow-platform/installed-e2e-runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await expect(window).toHaveURL(/^file:/);
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.workflowRuntime?.restart === "function"),
      )
      .toBe(true);
    await expect
      .poll(() => window.evaluate(() => window.workflowRuntime?.status()))
      .toMatchObject({ mode: "managed", state: "ready", port: installedRuntimePort });
    await window.getByRole("link", { name: "恢复" }).click();
    await expect(window.getByRole("heading", { name: "恢复" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("已安装桌面 EXE 可运行 Shell 终端并发送 Ctrl+C", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-installed-terminal-"));

  const app = await electron.launch({
    executablePath: installedDesktopExecutable!,
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(installedTerminalRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await expect(window.getByRole("cell", { name: "harness_project" })).toBeVisible();

    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`安装版终端-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();

    await window.getByRole("link", { name: "终端" }).click();
    await window.getByLabel("项目根目录").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "创建终端" }).click();
    await writeTerminalCommand(window, "echo installed-terminal-e2e");
    await expect(window.getByLabel("ANSI 终端文本", { exact: true })).toContainText("installed-terminal-e2e");
    await window.getByRole("button", { name: "中断" }).click();
    await expect(window.getByText("已发送 Ctrl+C 中断信号")).toBeVisible();
    await window.getByRole("button", { name: "停止终端" }).click();
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("已安装桌面 EXE 拒绝危险终端命令并写入 Runtime 审计", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-installed-terminal-approval-"));
  const app = await electron.launch({
    executablePath: installedDesktopExecutable!,
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(installedTerminalApprovalRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`安装版终端审批-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();

    await window.getByRole("link", { name: "终端" }).click();
    await window.getByLabel("项目根目录").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "创建终端" }).click();
    await writeTerminalCommand(window, "del .\\build");
    await expect(window.getByRole("dialog", { name: "确认危险命令" })).toBeVisible();
    await window.getByRole("button", { name: "取消危险命令" }).click();
    await expect(window.getByText("危险命令已被用户拒绝。")).toBeVisible();
    await expect(window.getByLabel("ANSI 终端文本", { exact: true })).not.toContainText("del .\\build");

    await window.getByRole("link", { name: "审计" }).click();
    await expect(window.getByText("terminal.command.rejected")).toBeVisible();
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("已安装桌面 EXE 可通过界面运行真实 Codex CLI 的无副作用任务", async () => {
  test.skip(
    !installedRealProviderExecutable,
    "需要通过 INSTALLED_REAL_PROVIDER_EXE 显式启用真实 Provider 验收。",
  );
  test.setTimeout(180_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-installed-codex-"));

  const app = await electron.launch({
    executablePath: installedRealProviderExecutable!,
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(installedProviderRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await expect(window.getByRole("cell", { name: "harness_project" })).toBeVisible();

    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`安装版真实 Codex-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();
    await expect(window.getByLabel("当前运行摘要").getByText("CREATED")).toBeVisible();

    const providerOption = window.getByLabel("Agent Provider").locator("option[value='codex']");
    await expect(providerOption).toBeEnabled();
    await window.getByLabel("Agent Provider").selectOption("codex");
    await window.getByLabel("Agent 提示词").fill(
      "只回复“安装版 Codex CLI 已连通”。不要读取、创建、修改或删除任何文件；不要执行命令。",
    );
    await window.getByRole("button", { name: "启动 Agent" }).click();

    await expect(window.getByLabel("Agent 任务")).toContainText("COMPLETED", {
      timeout: 150_000,
    });
    await expect(window.getByLabel("Agent 输出")).toHaveText(/\S/);
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("已安装桌面 EXE 可通过界面运行真实 Claude Code CLI 的无副作用任务", async () => {
  test.skip(
    !installedRealProviderExecutable,
    "需要通过 INSTALLED_REAL_PROVIDER_EXE 显式启用真实 Provider 验收。",
  );
  test.setTimeout(180_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-installed-claude-"));

  const app = await electron.launch({
    executablePath: installedRealProviderExecutable!,
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(installedProviderRuntimePort + 1),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await expect(window.getByRole("cell", { name: "harness_project" })).toBeVisible();

    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`安装版真实 Claude-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();
    await expect(window.getByLabel("当前运行摘要").getByText("CREATED")).toBeVisible();

    const providerOption = window.getByLabel("Agent Provider").locator("option[value='claude']");
    await expect(providerOption).toBeEnabled();
    await window.getByLabel("Agent Provider").selectOption("claude");
    await window.getByLabel("Agent 提示词").fill(
      "只回复“安装版 Claude Code CLI 已连通”。不要读取、创建、修改或删除任何文件；不要执行命令。",
    );
    await window.getByRole("button", { name: "启动 Agent" }).click();

    await expect(window.getByLabel("Agent 任务")).toContainText("COMPLETED", {
      timeout: 150_000,
    });
    await expect(window.getByLabel("Agent 输出")).toHaveText(/\S/);
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
