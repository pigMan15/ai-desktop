import { _electron as electron, expect, test } from "@playwright/test";
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

test("已打包桌面 EXE 加载应用资源、启动受管 Runtime 并保持独立路由", async () => {
  const app = await electron.launch({
    executablePath: latestPackagedExecutable(),
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
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.workflowRuntime?.status === "function"),
      )
      .toBe(true);
    await expect
      .poll(() => window.evaluate(() => window.workflowRuntime?.status()))
      .toMatchObject({ mode: "managed", state: "ready", port: packagedRuntimePort });
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
  }
});

test("已打包桌面 EXE 拒绝危险终端命令并写入 Runtime 审计", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-packaged-terminal-approval-"));
  const app = await electron.launch({
    executablePath: latestPackagedExecutable(),
    env: {
      ...process.env,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(packagedRuntimePort + 1),
      WORKFLOW_PLATFORM_RUNTIME_DB: path.join(temporaryRoot, "runtime.db"),
    },
  });

  try {
    const window = await app.firstWindow();
    await window.getByLabel("项目路径").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill(`打包版终端审批-${Date.now()}`);
    await window.getByRole("button", { name: "创建 Run" }).click();

    await window.getByRole("link", { name: "终端" }).click();
    await window.getByLabel("项目根目录").fill(fixtureProjectPath);
    await window.getByRole("button", { name: "创建终端" }).click();
    await window.getByLabel("终端输入").fill("del .\\build");
    await window.getByRole("button", { name: "发送输入" }).click();
    await expect(window.getByRole("dialog", { name: "确认危险命令" })).toBeVisible();
    await window.getByRole("button", { name: "取消危险命令" }).click();
    await expect(window.getByText("危险命令已被用户拒绝。")).toBeVisible();
    await expect(window.getByLabel("终端输出", { exact: true })).not.toContainText("del .\\build");

    await window.getByRole("link", { name: "审计" }).click();
    await expect(window.getByText("terminal.command.rejected")).toBeVisible();
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("已打包桌面 EXE 在受控命令边界内展示部署和知识合成实时输出", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "workflow-packaged-e2e-"));
  const projectPath = path.join(temporaryRoot, "project");
  const fakeCliDirectory = path.join(temporaryRoot, "bin");
  const runtimeDatabase = path.join(temporaryRoot, "runtime.db");
  cpSync(fixtureProjectPath, projectPath, { recursive: true });
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
    env: {
      ...process.env,
      PATH: `${fakeCliDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      WORKFLOW_PLATFORM_RUNTIME_URL: "",
      WORKFLOW_PLATFORM_RUNTIME_PORT: String(packagedWorkflowRuntimePort),
      WORKFLOW_PLATFORM_RUNTIME_DB: runtimeDatabase,
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "项目工作区" })).toBeVisible();
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.workflowRuntime?.status === "function"),
      )
      .toBe(true);
    await expect
      .poll(() => window.evaluate(() => window.workflowRuntime?.status()))
      .toMatchObject({ mode: "managed", state: "ready", port: packagedWorkflowRuntimePort });

    await window.getByLabel("项目路径").fill(projectPath);
    await window.getByRole("button", { name: "导入项目" }).click();
    await expect(window.getByRole("cell", { name: "project" })).toBeVisible();

    await window.getByRole("link", { name: "工作流" }).click();
    const definition = JSON.parse(await window.getByLabel("工作流定义 JSON").inputValue());
    definition.nodes = [
      {
        id: "deploy",
        name: "打包版部署",
        kind: "deploy",
        metadata: {
          deploy: {
            command: [packagedDeployCommand],
            timeoutSeconds: 30,
          },
        },
      },
    ];
    definition.edges = [];
    definition.gates = [];
    await window.getByLabel("工作流定义 JSON").fill(JSON.stringify(definition, null, 2));
    await window.getByRole("button", { name: "保存新版本" }).click();
    await expect(window.getByLabel("比较版本").locator("option")).toHaveCount(3);

    await window.getByRole("link", { name: "运行" }).click();
    await window.getByLabel("Run 名称").fill("打包版部署验收");
    await window.getByRole("button", { name: "创建 Run" }).click();
    const readPersistedRunId = () => window.evaluate(() => {
      const rawSession = window.localStorage.getItem("ai-workflow-platform.workspace-session.v1");
      const session = rawSession ? (JSON.parse(rawSession) as { runId?: unknown }) : null;
      return typeof session?.runId === "string" && session.runId.trim() ? session.runId : null;
    });
    await expect.poll(readPersistedRunId).not.toBeNull();
    const runId = await readPersistedRunId();
    if (!runId) {
      throw new Error("打包版 E2E 未能从工作区会话读取新建 Run ID。");
    }
    await window.getByLabel("节点 ID").fill("deploy");
    await window.getByRole("button", { name: "启动部署" }).click();
    await expect(window.getByLabel("部署实时输出")).toHaveText(/\S/);
    await expect(window.getByLabel("部署会话")).toContainText("COMPLETED");

    await window.getByRole("link", { name: "知识库" }).click();
    await window.getByLabel("知识标题").fill("打包版知识规则");
    await window.getByLabel("知识内容").fill("打包版必须展示合成输出。");
    await window.getByLabel("知识来源").fill(`run:${runId}`);
    await window.getByRole("button", { name: "创建候选" }).click();
    await window.getByRole("button", { name: "批准候选" }).click();
    await window.getByRole("button", { name: "开始 CLI 合成：打包版知识规则" }).click();
    await expect(window.getByLabel("合成实时输出：打包版知识规则")).toContainText(
      "packaged-knowledge-final",
    );
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
