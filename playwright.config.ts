import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const runtimePort = Number(process.env.PLAYWRIGHT_RUNTIME_PORT ?? 8765);
const rendererPort = Number(process.env.PLAYWRIGHT_RENDERER_PORT ?? 5173);
const runtimeApiBaseUrl = `http://127.0.0.1:${runtimePort}`;
const rendererBaseUrl = `http://127.0.0.1:${rendererPort}`;
const fixtureProjectPath = path.resolve("runtime/tests/fixtures/harness_project");
const fixtureArtifactPath = path.join(fixtureProjectPath, "plan.md");
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVERS === "1";
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: rendererBaseUrl,
    trace: "on-first-retry",
  },
  webServer: skipWebServer
    ? undefined
    : [
        {
          command:
            `python -m uvicorn workflow_platform.api.app:create_runtime_app --host 127.0.0.1 --port ${runtimePort} --factory`,
          url: `${runtimeApiBaseUrl}/health`,
          env: {
            PYTHONPATH: path.resolve("runtime/src"),
            WORKFLOW_PLATFORM_RUNTIME_DB: path.resolve(".workflow-platform/e2e-runtime.db"),
          },
          reuseExistingServer,
          timeout: 120_000,
        },
        {
          command: `npm run dev:renderer -- --port ${rendererPort}`,
          url: rendererBaseUrl,
          env: {
            VITE_RUNTIME_API_BASE_URL: runtimeApiBaseUrl,
            VITE_RUNTIME_PROJECT_PATH: fixtureProjectPath,
            VITE_RUNTIME_ARTIFACT_PATH: fixtureArtifactPath,
          },
          reuseExistingServer,
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
