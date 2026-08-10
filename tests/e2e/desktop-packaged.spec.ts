import { _electron as electron, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const packagedRuntimePort = 8878;
const packagedWorkflowRuntimePort = 8880;
const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");
const packagedDeployCommand = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "hostname.exe",
);

async function waitForManagedRuntime(window: Page, port: number) {
  await expect
    .poll(() =>
      window.evaluate(() => typeof window.workflowRuntime?.status === "function"),
    )
    .toBe(true);
  await expect
    .poll(() => window.evaluate(() => window.workflowRuntime?.status()))
    .toMatchObject({ mode: "managed", state: "ready", port });
}

function packagedLaunchArgs(userDataDirectory: string): string[] {
  return [`--user-data-dir=${userDataDirectory}`];
}

function latestPackagedExecutable(): string {
  const root = path.resolve(".");
  const releaseDirectory = ["release-full", ...readdirSync(root).filter((name) => name.startsWith("release-full-"))]
    .filter((name) => existsSync(path.join(root, name, "win-unpacked", "AI Workflow Platform.exe")))
    .sort(
      (left, right) =>
        statSync(path.join(root, right)).mtimeMs - statSync(path.join(root, left)).mtimeMs,
    )[0];
  if (!releaseDirectory) {
    throw new Error("未找到完整 Windows 发布目录。请先执行 npm run package:win:full。");
  }
  return path.join(root, releaseDirectory, "win-unpacked", "AI Workflow Platform.exe");
}

test("已打包桌面 EXE 可读取内置知识示例包资源", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-packaged-knowledge-"));
  const app = await electron.launch({
    executablePath: latestPackagedExecutable(),
    args: packagedLaunchArgs(path.join(temporaryRoot, "user-data")),
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(packagedWorkflowRuntimePort + 1),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await waitForManagedRuntime(window, packagedWorkflowRuntimePort + 1);
    const examples = await window.evaluate(async () => {
      const result = (await window.workflowRuntime?.request({
        path: "/knowledge-examples",
        method: "GET",
      })) as { kind?: string; value?: { items?: unknown[] } };
      return result.kind === "success" ? result.value : result;
    });
    expect((examples as { items?: unknown[] }).items?.length ?? 0).toBeGreaterThan(0);
    const initialized = await window.evaluate(async (targetPath) => {
      const result = (await window.workflowRuntime?.request({
        path: "/knowledge-examples/complex-business/initialize",
        method: "POST",
        body: {
          mode: "complete",
          targetPath,
          initializeGit: true,
          actor: { id: "e2e", type: "human", source: "renderer", trusted: true },
          now: new Date().toISOString(),
        },
      })) as { kind?: string; value?: { createdFiles?: string[]; gitInitialized?: boolean } };
      return result.kind === "success" ? result.value : result;
    }, path.join(temporaryRoot, "kb-init"));
    expect((initialized as { createdFiles?: string[] }).createdFiles?.length ?? 0).toBeGreaterThan(0);
    expect((initialized as { gitInitialized?: boolean }).gitInitialized).toBe(true);
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("已打包桌面 EXE 加载应用资源、启动受管 Runtime 并保持独立路由", async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-packaged-startup-"));
  const app = await electron.launch({
    executablePath: latestPackagedExecutable(),
    args: packagedLaunchArgs(path.join(temporaryRoot, "user-data")),
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(packagedRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.resolve(".workflow-platform/packaged-e2e-runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await expect(window).toHaveURL(/^file:/);
    await waitForManagedRuntime(window, packagedRuntimePort);
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.workflowGit?.publishKnowledgeDocument === "function"),
      )
      .toBe(true);
    await window.getByRole("link", { name: "终端" }).click();
    await expect(window.getByRole("heading", { name: "终端" })).toBeVisible();
    await window.getByRole("link", { name: "设置" }).click();
    await expect(window.getByRole("heading", { name: "运行时设置" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// 终端 UI 已重构为“执行工作区 + 绑定节点 + 终端类型”选择器，原流程待按新交互重写。
test.skip("已打包桌面 EXE 拒绝危险终端命令并写入 Runtime 审计", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-packaged-terminal-approval-"));
  const app = await electron.launch({
    executablePath: latestPackagedExecutable(),
    args: packagedLaunchArgs(path.join(temporaryRoot, "user-data")),
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(packagedRuntimePort + 1),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await waitForManagedRuntime(window, packagedRuntimePort + 1);
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await window.getByRole("link", { name: "运行" }).click();
    await window.getByRole("button", { name: "新建 Run" }).last().click();
    await window.getByLabel("Run 名称").fill(`打包版终端审批-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();

    await window.getByRole("link", { name: "终端" }).click();
    await window.getByLabel("执行工作区").selectOption({ label: fixtureProjectPath });
    await window.getByLabel("终端类型").selectOption("shell");
    await window.getByRole("button", { name: "创建终端" }).click();
    await window.getByLabel("ANSI 终端", { exact: true }).click();
    await window.keyboard.type("del .\\build");
    await window.keyboard.press("Enter");
    await expect(window.getByRole("dialog", { name: "确认危险命令" })).toBeVisible();
    await window.getByRole("button", { name: "取消危险命令" }).click();
    await expect(window.getByText("危险命令已被用户拒绝。")).toBeVisible();
    await expect(window.getByLabel("ANSI 终端文本")).not.toContainText("del .\\build");

    await window.getByRole("link", { name: "审计" }).click();
    await expect(window.getByText("terminal.command.rejected")).toBeVisible();
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("已打包桌面 EXE 保留旧知识候选、审核与发布 API", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-packaged-knowledge-api-"));
  const fakeCliDirectory = path.join(temporaryRoot, "bin");
  mkdirSync(fakeCliDirectory);
  writeFileSync(
    path.join(fakeCliDirectory, "codex.cmd"),
    [
      "@echo off",
      "echo {\"type\":\"message\",\"text\":\"packaged-knowledge-progress\"}",
      "echo {\"type\":\"final\",\"text\":\"packaged-knowledge-final\"}",
    ].join("\r\n"),
    "utf8",
  );

  const app = await electron.launch({
    executablePath: latestPackagedExecutable(),
    args: packagedLaunchArgs(path.join(temporaryRoot, "user-data")),
    env: {
      ...process.env,
      PATH: `${fakeCliDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(packagedWorkflowRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await waitForManagedRuntime(window, packagedWorkflowRuntimePort);
    const actor = { id: "e2e", type: "human", source: "renderer", trusted: true };
    const now = new Date().toISOString();

    const invokeRuntime = (request: { path: string; method: "GET" | "POST"; body?: unknown }) =>
      window.evaluate(async (options) => {
        const result = (await window.workflowRuntime?.request(options)) as {
          kind?: string;
          value?: unknown;
        };
        return result.kind === "success" ? result.value : result;
      }, request);

    // 创建候选
    const created = (await invokeRuntime({
      path: "/knowledge/candidates",
      method: "POST",
      body: { title: "打包版知识规则", content: "打包版必须展示合成输出。", source: "manual", actor, now },
    })) as { id: string };
    expect(created.id).toBeTruthy();

    // 审核通过
    await invokeRuntime({
      path: `/knowledge/candidates/${created.id}/review`,
      method: "POST",
      body: { decision: "approved", actor, now },
    });

    // 发布候选 → 生成知识文档（旧知识写链路在打包版仍可用）
    const published = (await invokeRuntime({
      path: `/knowledge/candidates/${created.id}/publish`,
      method: "POST",
      body: { actor, now },
    })) as { documentId?: string };
    expect(published.documentId ?? published.id).toBeTruthy();

    // 已发布文档可读取
    await expect
      .poll(
        async () => {
          const documents = (await invokeRuntime({
            path: "/knowledge/documents",
            method: "GET",
          })) as Array<{ id: string; title?: string }>;
          return JSON.stringify(documents);
        },
        { timeout: 10_000 },
      )
      .toContain("打包版知识规则");
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

