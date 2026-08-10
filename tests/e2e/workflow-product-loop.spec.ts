import { expect, test } from "@playwright/test";
import path from "node:path";

const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");

async function importFixtureProject(page: import("@playwright/test").Page) {
  await page.goto("/#/projects");
  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();
  await page.getByRole("link", { name: "运行" }).click();
}

async function openNewRun(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "新建 Run" }).last().click();
  await expect(page).toHaveURL(/#\/runs\/new$/);
}

test("用户可通过项目 Run 列表创建并恢复详情路由", async ({ page }) => {
  await importFixtureProject(page);
  await openNewRun(page);
  await page.getByLabel("Run 名称").fill("端到端运行");
  await page.getByRole("radio", { name: "只读" }).check();
  await page.getByRole("button", { name: "创建 Run" }).click();

  await expect(page).toHaveURL(/#\/runs\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "端到端运行" })).toBeVisible();
  const detailUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole("heading", { name: "端到端运行" })).toBeVisible();

  await page.getByRole("link", { name: "返回 Run 列表" }).click();
  await expect(page.getByText("端到端运行")).toBeVisible();
});

test("用户可创建并比较多个带独立配置的 Run", async ({ page }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const firstRunTitle = `发布验证 A-${suffix}`;
  const secondRunTitle = `发布验证 B-${suffix}`;
  await importFixtureProject(page);
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-workflow-platform.workspace-session.v1") ?? "{}"));
  await page.request.put(`${session.apiBaseUrl}/projects/${encodeURIComponent(session.projectId)}/concurrency`, {
    data: {
      maxActiveRuns: 10,
      maxActiveAgents: 2,
      actor: { id: "e2e", type: "human", source: "renderer", trusted: true },
      now: new Date().toISOString(),
    },
  });

  await openNewRun(page);
  await page.getByLabel("Run 名称").fill(firstRunTitle);
  await page.getByLabel("运行目标").fill("验证 A 环境发布流程");
  await page.getByLabel("运行参数").fill('{"dryRun":true,"region":"cn-north-1"}');
  await page.getByRole("radio", { name: "只读" }).check();
  await page.getByRole("button", { name: "创建 Run" }).click();
  await expect(page.getByRole("heading", { name: firstRunTitle })).toBeVisible();

  await page.getByRole("link", { name: "返回 Run 列表" }).click();
  await openNewRun(page);
  await page.getByLabel("Run 名称").fill(secondRunTitle);
  await page.getByLabel("运行目标").fill("验证 B 环境回滚流程");
  await page.getByLabel("运行参数").fill('{"dryRun":false,"region":"cn-north-2"}');
  await page.getByRole("radio", { name: "只读" }).check();
  await page.getByRole("button", { name: "创建 Run" }).click();
  await expect(page.getByRole("heading", { name: secondRunTitle })).toBeVisible();

  await page.getByRole("link", { name: "返回 Run 列表" }).click();
  await expect(page.getByText(firstRunTitle)).toBeVisible();
  await expect(page.getByText(secondRunTitle)).toBeVisible();
  await page.getByText(firstRunTitle).click();
  await expect(page.getByText("验证 A 环境发布流程")).toBeVisible();
  await expect(page.getByText(/cn-north-1/)).toBeVisible();
});
