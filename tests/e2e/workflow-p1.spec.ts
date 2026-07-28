import { expect, test } from "@playwright/test";
import path from "node:path";

const runtimeApiBaseUrl = "http://127.0.0.1:8765";
const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");
const fixtureArtifactPath = path.join(fixtureProjectPath, "plan.md");

test("renderer shows P1 runtime-backed product loop state", async ({ page }) => {
  const params = new URLSearchParams({
    runtimeApiBaseUrl,
    runtimeProjectPath: fixtureProjectPath,
    runtimeArtifactPath: fixtureArtifactPath,
  });

  await page.goto(`http://127.0.0.1:5173?${params.toString()}`);
  await expect(page.getByText("Runtime API 已连接")).toBeVisible();
  await expect(page.getByRole("cell", { name: "harness_project" })).toBeVisible();
  await expect(page.getByText("GATE_PASSED：plan")).toBeVisible();
  await expect(page.getByRole("region", { name: "Artifacts" }).getByText(/plan\.md/)).toBeVisible();
  await expect(page.getByText(/Renderer P1 人工审批通过/)).toBeVisible();
});
