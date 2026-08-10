import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

function createKnowledgeRepository(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-e2e-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "e2e@example.com");
  git(dir, "config", "user.name", "E2E");
  fs.mkdirSync(path.join(dir, "candidate"));
  fs.mkdirSync(path.join(dir, "main"));
  fs.mkdirSync(path.join(dir, ".ai-workflow"));
  fs.writeFileSync(path.join(dir, "KNOWLEDGE-RULES.md"), "# 知识规则\n", "utf-8");
  fs.writeFileSync(path.join(dir, "INDEX.md"), "# 索引\n", "utf-8");
  fs.writeFileSync(
    path.join(dir, ".ai-workflow", "knowledge-repo.yaml"),
    [
      "version: 1",
      "rules:",
      "  - KNOWLEDGE-RULES.md",
      "indexes:",
      "  - INDEX.md",
      "writablePaths:",
      "  - candidate/**",
      "  - main/**",
      "  - '*.md'",
      "protectedPaths:",
      "  - .git/**",
      "validation:",
      "  commands: []",
    ].join("\n"),
    "utf-8",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function readSession(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("ai-workflow-platform.workspace-session.v1") ?? "{}"),
  );
}

async function createRunAndArtifact(
  page: import("@playwright/test").Page,
  session: { apiBaseUrl: string; projectId: string },
  workspacePath: string = fixtureProjectPath,
) {
  const now = new Date().toISOString();
  const importResponse = await page.request.post(`${session.apiBaseUrl}/projects/import`, {
    data: { projectPath: fixtureProjectPath, now },
  });
  expect(importResponse.ok()).toBeTruthy();
  const imported = await importResponse.json();
  const projectId = imported.projectId;
  await page.request.put(`${session.apiBaseUrl}/projects/${encodeURIComponent(projectId)}/concurrency`, {
    data: {
      maxActiveRuns: 10,
      maxActiveAgents: 2,
      actor: { id: "e2e", type: "human", source: "renderer", trusted: true },
      now,
    },
  });
  const createdResponse = await page.request.post(
    `${session.apiBaseUrl}/projects/${encodeURIComponent(projectId)}/runs`,
    {
      headers: { "Idempotency-Key": `knowledge-e2e-${Date.now()}` },
      data: {
        workflowVersionId: imported.workflowVersionId,
        title: "知识库 E2E Run",
        taskGoal: "生成知识",
        parameters: {},
        executionWorkspace: { path: workspacePath, mode: "write" },
        actor: { id: "e2e", type: "human", source: "renderer", trusted: true },
        now,
      },
    },
  );
  expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();
  const created = await createdResponse.json();
  const projection = created.projection;
  const runId = projection.runId;
  const startAction = projection.allowedActions.find(
    (action: { eventType: string; nodeId?: string }) =>
      action.eventType === "NODE_STARTED" && action.nodeId === "plan",
  );
  const started = await (
    await page.request.post(
      `${session.apiBaseUrl}/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/actions`,
      {
        data: {
          actionId: startAction.id,
          expectedRevision: projection.revision,
          actor: { id: "e2e-agent", type: "agent", source: "agent", trusted: true },
          payload: null,
          now,
        },
      },
    )
  ).json();
  const artifactPath = path.join(workspacePath, "plan.md");
  fs.writeFileSync(artifactPath, "# E2E Plan\n", "utf-8");
  const artifact = await (
    await page.request.post(
      `${session.apiBaseUrl}/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/artifacts`,
      {
        data: {
          nodeId: "plan",
          artifactPath,
          artifactType: "markdown",
          actor: { id: "e2e-agent", type: "agent", source: "agent", trusted: true },
          expectedRevision: started.projection.revision,
          now,
        },
      },
    )
  ).json();
  const artifacts = await (
    await page.request.get(
      `${session.apiBaseUrl}/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/artifacts`,
    )
  ).json();
  return { projectId, runId, artifactId: artifacts[0].id, artifact };
}

test("知识库导入、规则确认、Fake 变更集写入与提交全流程", async ({ page }) => {
  const kbDir = createKnowledgeRepository();
  const repositoryName = `E2E 知识库-${Date.now()}`;
  await page.goto("/#/knowledge/repositories");
  await expect(page.getByRole("heading", { name: "知识库" })).toBeVisible();

  // 导入知识库
  await page.getByLabel("仓库名称").fill(repositoryName);
  await page.getByLabel("仓库根目录").fill(kbDir);
  await page.getByRole("button", { name: "导入" }).click();
  await expect(page.getByText("知识库导入成功")).toBeVisible();
  await expect(page.getByRole("button", { name: repositoryName })).toBeVisible();
  await page.getByRole("button", { name: repositoryName }).click();

  // 发现并确认规则（Fake Provider）
  await page.getByLabel("Provider").selectOption("fake");
  await page.getByRole("button", { name: "发现规则" }).click();
  await expect(page.getByText("规则发现完成，请确认报告")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认规则" }).click();
  await expect(page.getByText("规则快照已确认，仓库已激活")).toBeVisible({ timeout: 10_000 });

  // 通过 Runtime API 准备 Run 与 Artifact
  await page.goto("/#/projects");
  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();
  const session = await readSession(page);
  const runWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-workspace-"));
  fs.cpSync(fixtureProjectPath, runWorkspace, { recursive: true });
  const { projectId, runId, artifactId } = await createRunAndArtifact(page, session, runWorkspace);

  // 打开变更集创建页并创建
  await page.goto(
    `/#/knowledge/change-sets/new?projectId=${encodeURIComponent(projectId)}&runId=${encodeURIComponent(runId)}`,
  );
  await expect(page.getByRole("heading", { name: "创建知识变更集" })).toBeVisible();
  await page.getByLabel("目标知识库").selectOption({ label: repositoryName });
  await page.getByRole("checkbox").first().check();
  await page.getByLabel("Provider").selectOption("fake");
  await page.getByRole("button", { name: "创建变更集" }).click();

  // 生成 → READY_TO_APPLY
  await expect(page.getByRole("heading", { name: "知识变更集" })).toBeVisible();
  await expect(page.getByText("DRAFT")).toBeVisible();
  await page.getByRole("button", { name: "生成变更集" }).click();
  await expect(page.getByText("READY_TO_APPLY")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("LOW", { exact: true })).toBeVisible();

  // 应用 → 暂存 → 提交
  await page.getByRole("button", { name: "应用" }).click();
  await expect(page.getByText("APPLIED")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "暂存全部", exact: true }).click();
  await expect(page.getByText("STAGED")).toBeVisible();
  await page.getByLabel("提交标题").fill("knowledge: add E2E candidate");
  await page.getByRole("button", { name: "提交" }).click();
  await expect(page.getByText("COMMITTED")).toBeVisible({ timeout: 15_000 });

  // 验证仓库已提交
  const head = git(kbDir, "log", "--oneline", "-1");
  expect(head).toContain("knowledge: add E2E candidate");
});

test("外部修改目标文件后变更集进入 STALE 且不再可应用", async ({ page }) => {
  const kbDir = createKnowledgeRepository();
  const repositoryName = `STALE 知识库-${Date.now()}`;
  await page.goto("/#/knowledge/repositories");
  await page.getByLabel("仓库名称").fill(repositoryName);
  await page.getByLabel("仓库根目录").fill(kbDir);
  await page.getByRole("button", { name: "导入" }).click();
  await expect(page.getByRole("button", { name: repositoryName })).toBeVisible();
  await page.getByRole("button", { name: repositoryName }).click();
  await page.getByLabel("Provider").selectOption("fake");
  await page.getByRole("button", { name: "发现规则" }).click();
  await expect(page.getByText("规则发现完成，请确认报告")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认规则" }).click();
  await expect(page.getByText("规则快照已确认，仓库已激活")).toBeVisible({ timeout: 10_000 });

  await page.goto("/#/projects");
  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();
  const session = await readSession(page);
  const staleWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-workspace-"));
  fs.cpSync(fixtureProjectPath, staleWorkspace, { recursive: true });
  const { projectId, runId, artifactId } = await createRunAndArtifact(page, session, staleWorkspace);

  await page.goto(
    `/#/knowledge/change-sets/new?projectId=${encodeURIComponent(projectId)}&runId=${encodeURIComponent(runId)}`,
  );
  await page.getByLabel("目标知识库").selectOption({ label: repositoryName });
  await page.getByRole("checkbox").first().check();
  await page.getByLabel("Provider").selectOption("fake");
  await page.getByRole("button", { name: "创建变更集" }).click();
  await page.getByRole("button", { name: "生成变更集" }).click();
  await expect(page.getByText("READY_TO_APPLY")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "应用" }).click();
  await expect(page.getByText("APPLIED")).toBeVisible({ timeout: 15_000 });

  // 外部修改仓库 HEAD（模拟外部提交）→ 基线变化 → STALE
  git(kbDir, "commit", "-q", "--allow-empty", "-m", "external change");
  await page.getByRole("button", { name: "刷新" }).click();
  await expect(page.getByText("STALE")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "应用" })).toHaveCount(0);
});
