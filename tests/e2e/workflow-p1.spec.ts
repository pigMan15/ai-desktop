import { expect, test } from "@playwright/test";
import path from "node:path";

const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");

test("renderer connects to Runtime and imports a workflow project", async ({ page }) => {
  await page.goto("/#/projects");
  await expect(page.getByText("Runtime 已连接")).toBeVisible();
  const initialPanelCoverage = await page.locator(".content-grid > .panel:only-child").evaluate((panel) => {
    const grid = panel.parentElement?.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return grid && grid.width > 0 ? panelRect.width / grid.width : 0;
  });
  expect(initialPanelCoverage).toBeGreaterThan(0.98);
  await page.getByLabel("项目路径").fill(fixtureProjectPath);
  await page.getByRole("button", { name: "导入项目" }).click();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();
});
