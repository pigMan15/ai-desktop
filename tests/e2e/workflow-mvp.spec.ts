import { expect, test } from "@playwright/test";

test("renderer shows MVP workbench", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");

  await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
});
