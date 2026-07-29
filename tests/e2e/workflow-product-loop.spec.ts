import { expect, test } from "@playwright/test";
import path from "node:path";

const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");
const fixtureArtifactPath = path.join(fixtureProjectPath, "plan.md");

test("用户可通过界面完成 Runtime 工作流治理闭环", async ({ page }) => {
  await page.goto("/#/projects");

  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();

  await page.getByRole("link", { name: "运行" }).click();
  await page.getByLabel("Run 名称").fill("端到端运行");
  await page.getByRole("button", { name: "创建 Run" }).click();
  await expect(page.getByLabel("当前运行摘要").getByText("CREATED")).toBeVisible();

  await page.getByRole("button", { name: "暂停 Run" }).click();
  await expect(page.getByLabel("当前运行摘要").getByText("PAUSED")).toBeVisible();

  await page.getByRole("button", { name: "恢复 Run" }).click();
  await expect(page.getByLabel("当前运行摘要").getByText("CREATED")).toBeVisible();

  await page.getByRole("button", { name: "启动节点" }).click();
  await expect(page.getByLabel("当前运行摘要").getByText("IN_PROGRESS")).toBeVisible();

  await page.getByLabel("Artifact 路径").fill(fixtureArtifactPath);
  await page.getByRole("button", { name: "提交 Artifact" }).click();
  await expect(page.getByLabel("当前运行摘要").getByText("REVIEWING")).toBeVisible();

  await page.getByRole("button", { name: "人工批准" }).click();
  await expect(page.getByText("AWAITING_GATE")).toBeVisible();

  await page.getByRole("button", { name: "通过 Gate" }).click();
  await expect(page.getByRole("list", { name: "Runtime Timeline" }).getByText(/GATE_PASSED/)).toBeVisible();

  await page.getByRole("link", { name: "门禁" }).click();
  await expect(page.getByText("plan-ready")).toBeVisible();
  await expect(page.getByLabel("Gate 审查记录").getByText("passed")).toBeVisible();
});

test("用户可创建并切换多个带独立配置的 Run", async ({ page }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const firstRunTitle = `发布验证 A-${suffix}`;
  const secondRunTitle = `发布验证 B-${suffix}`;
  await page.goto("/#/projects");

  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await page.getByRole("link", { name: "运行" }).click();

  await page.getByLabel("Run 名称").fill(firstRunTitle);
  await page.getByLabel("任务目标").fill("验证 A 环境发布流程");
  await page.getByLabel("运行参数（JSON 对象）").fill('{"dryRun":true,"region":"cn-north-1"}');
  await page.getByRole("button", { name: "创建 Run" }).click();
  await expect(page.getByText("验证 A 环境发布流程")).toBeVisible();

  await page.getByLabel("新建 Run 名称").fill(secondRunTitle);
  await page.getByLabel("任务目标").fill("验证 B 环境回滚流程");
  await page.getByLabel("运行参数（JSON 对象）").fill('{"dryRun":false,"region":"cn-north-2"}');
  await page.getByRole("button", { name: "创建并切换 Run" }).click();
  await expect(page.getByText("验证 B 环境回滚流程")).toBeVisible();

  const firstRunId = await page
    .getByLabel("切换 Run")
    .locator("option")
    .filter({ hasText: firstRunTitle })
    .getAttribute("value");
  await page.getByLabel("切换 Run").selectOption(firstRunId ?? "");

  await expect(page.getByText("验证 A 环境发布流程")).toBeVisible();
  await expect(page.getByLabel("运行参数", { exact: true })).toContainText(
    '"region": "cn-north-1"',
  );
});
