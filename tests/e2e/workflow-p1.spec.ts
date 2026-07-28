import { expect, test } from "@playwright/test";

test("renderer shows P1 runtime-backed product loop state", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await expect(page.getByText("Runtime API 已连接")).toBeVisible();
  await expect(page.getByText("demo-workflow")).toBeVisible();
  await expect(page.getByText("artifact://plan.md")).toBeVisible();
  await expect(page.getByText("WAITING_FOR_HUMAN")).toBeVisible();
});
