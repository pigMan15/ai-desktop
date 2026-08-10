import { expect, test } from "@playwright/test";
import path from "node:path";

const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");

test("Run secondary pages keep the canonical project/run context", async ({ page }) => {
  await page.goto("/#/projects");
  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();
  await page.getByRole("link", { name: "运行" }).click();
  await page.getByRole("button", { name: "新建 Run" }).last().click();
  await page.getByLabel("Run 名称").fill(`Phase 4 ${Date.now()}`);
  await page.getByRole("button", { name: "创建 Run" }).click();
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/);

  const artifactsLink = page.getByRole("navigation", { name: "Run 相关资源" }).getByRole("link", { name: "产物" });
  await artifactsLink.click();
  await expect(page).toHaveURL(/#\/artifacts\?projectId=[^&]+&runId=.+/);
  await expect(page.getByRole("link", { name: "返回 Run" })).toHaveAttribute("href", /#\/runs\/.+/);

  const terminalLink = page.getByRole("link", { name: /^Agent 终端 / }).first();
  if (await terminalLink.count()) {
    await terminalLink.click();
    await expect(page).toHaveURL(/#\/runs\/[^/]+\/terminal\/[^/]+/);
    await expect(page.getByRole("link", { name: "返回 Run" })).toHaveAttribute("href", /#\/runs\/.+/);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
