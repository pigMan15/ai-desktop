import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const desktopAppPath = path.resolve("apps/desktop");
const rendererPort = Number(process.env.PLAYWRIGHT_RENDERER_PORT ?? 5173);
const runtimePort = Number(process.env.PLAYWRIGHT_RUNTIME_PORT ?? 8765);
const rendererBaseUrl = `http://127.0.0.1:${rendererPort}`;
const runtimeApiBaseUrl = `http://127.0.0.1:${runtimePort}`;
const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");
const managedRuntimePort = Number(process.env.PLAYWRIGHT_ELECTRON_MANAGED_RUNTIME_PORT ?? 8877);

async function writeTerminalCommand(window: Page, command: string): Promise<void> {
  await window.getByLabel("ANSI 终端", { exact: true }).click();
  await window.keyboard.type(command);
  await window.keyboard.press("Enter");
}

async function waitForAppWindow(app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (const page of app.windows()) {
      const text = await page
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");
      if (text.includes("AI Workflow 工作台")) {
        return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("未找到已加载中文工作台的 Electron 窗口。");
}

test("桌面应用加载中文项目界面并暴露受控 Runtime 桥", async () => {
  const app = await electron.launch({
    args: [desktopAppPath],
    env: {
      ...process.env,
      RENDERER_URL: rendererBaseUrl,
      WORKFLOW_PLATFORM_RUNTIME_URL: runtimeApiBaseUrl,
    },
  });

  try {
    const window = await waitForAppWindow(app);
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.workflowRuntime?.status === "function"),
      )
      .toBe(true);
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.workflowGit?.previewKnowledgeDocument === "function"),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test("桌面应用启动受管 Runtime 并运行 Shell 终端会话", async () => {
  test.setTimeout(60_000);

  const app = await electron.launch({
    args: [desktopAppPath],
    env: {
      ...process.env,
      RENDERER_URL: rendererBaseUrl,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(managedRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.resolve(".workflow-platform/electron-managed-e2e.db"),
      PYTHONPATH: [path.resolve("runtime/src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  });

  try {
    const window = await waitForAppWindow(app);
    await expect
      .poll(() =>
        window.evaluate(async () => window.workflowRuntime?.status()),
      )
      .toMatchObject({ mode: "managed", state: "ready", port: managedRuntimePort });

    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await expect(window.getByRole("cell", { name: "harness_project" })).toBeVisible();

    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill("Electron 终端 E2E");
    await window.getByRole("button", { name: "创建 Run" }).click();
    await expect(window.getByLabel("当前运行摘要").getByText("CREATED")).toBeVisible();

    await window.getByRole("link", { name: "终端" }).click();
    await window.getByLabel("项目根目录").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "创建终端" }).click();
    await writeTerminalCommand(window, "echo managed-terminal-e2e");
    await expect(window.getByLabel("ANSI 终端文本", { exact: true })).toContainText("managed-terminal-e2e");
    await window.getByRole("button", { name: "停止终端" }).click();
  } finally {
    await app.close();
  }
});

test("桌面应用拒绝危险终端命令并保留中文审计记录", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-terminal-approval-"));
  const approvalRuntimePort = managedRuntimePort + 2;
  const app = await electron.launch({
    args: [desktopAppPath],
    env: {
      ...process.env,
      RENDERER_URL: rendererBaseUrl,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(approvalRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
      PYTHONPATH: [path.resolve("runtime/src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  });

  try {
    const window = await waitForAppWindow(app);
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`终端审批 E2E-${Date.now()}`);
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

test("桌面应用重启后可清理遗留终端并回放其已持久化输出", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-terminal-recovery-"));
  const recoveryRuntimePort = managedRuntimePort + 1;
  const runtimeDatabasePath = path.join(temporaryRoot, "runtime.db");
  const userDataDirectory = path.join(temporaryRoot, "electron-user-data");
  const outputMarker = `terminal-recovery-${Date.now()}`;
  let app: ElectronApplication | null = null;

  const launch = () =>
    electron.launch({
      args: [desktopAppPath, `--user-data-dir=${userDataDirectory}`],
      env: {
        ...process.env,
        RENDERER_URL: rendererBaseUrl,
        WORKFLOW_PLATFORM_RUNTIME_URL: "",
        WORKFLOW_PLATFORM_RUNTIME_PORT: String(recoveryRuntimePort),
        WORKFLOW_PLATFORM_RUNTIME_DB: runtimeDatabasePath,
        PYTHONPATH: [path.resolve("runtime/src"), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
    });

  try {
    app = await launch();
    let window = await waitForAppWindow(app);
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`终端恢复 E2E-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();

    await window.getByRole("link", { name: "终端" }).click();
    await window.getByLabel("项目根目录").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "创建终端" }).click();
    await writeTerminalCommand(window, `echo ${outputMarker}`);
    await expect(window.getByLabel("ANSI 终端文本", { exact: true })).toContainText(outputMarker);

    await app.close();
    app = await launch();
    window = await waitForAppWindow(app);
    await expect
      .poll(() => window.evaluate(async () => window.workflowRuntime?.status()))
      .toMatchObject({ mode: "managed", state: "ready", port: recoveryRuntimePort });

    await window.getByRole("link", { name: "恢复" }).click();
    await expect(window.getByText(/待恢复终端：.*terminal-session-/)).toBeVisible();
    await window.getByRole("button", { name: "清理遗留终端" }).click();
    await expect(window.getByRole("status")).toContainText("已清理遗留终端：1 个");

    await window.getByRole("link", { name: "终端" }).click();
    const historyOptions = window
      .getByLabel("历史终端会话")
      .locator("option")
      .filter({ hasText: "stopped" });
    await expect(historyOptions).toHaveCount(1);
    const historyOption = historyOptions.last();
    const historySessionId = await historyOption.getAttribute("value");
    await window.getByLabel("历史终端会话").selectOption(historySessionId ?? "");
    await window.getByRole("button", { name: "查看历史输出" }).click();
    await expect(window.getByLabel("ANSI 终端文本", { exact: true })).toContainText(outputMarker);
  } finally {
    await app?.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
