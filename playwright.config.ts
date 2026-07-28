import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const runtimeApiBaseUrl = "http://127.0.0.1:8765";
const rendererBaseUrl = "http://127.0.0.1:5173";
const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");
const fixtureArtifactPath = path.join(fixtureProjectPath, "plan.md");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: rendererBaseUrl,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command:
        "python -m uvicorn workflow_platform.api.app:create_runtime_app --host 127.0.0.1 --port 8765 --factory",
      url: `${runtimeApiBaseUrl}/health`,
      env: {
        PYTHONPATH: path.resolve("runtime/src"),
        WORKFLOW_PLATFORM_RUNTIME_DB: path.resolve(".workflow-platform/e2e-runtime.db"),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev:renderer -- --port 5173",
      url: rendererBaseUrl,
      env: {
        VITE_RUNTIME_API_BASE_URL: runtimeApiBaseUrl,
        VITE_RUNTIME_PROJECT_PATH: fixtureProjectPath,
        VITE_RUNTIME_ARTIFACT_PATH: fixtureArtifactPath,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
