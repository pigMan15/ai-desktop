import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeploymentPage } from "./DeploymentPage";

const item = { id: "deployment-1", runId: "run-1", nodeId: "deploy", command: ["publish"], cwd: "G:\\worktree", status: "RUNNING" as const, pid: 42, summary: null, error: null, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z" };

describe("DeploymentPage", () => {
  afterEach(() => cleanup());
  it("loads scoped deployments and output and returns to the same Run", async () => {
    const client = {
      listDeployments: vi.fn(async () => [item]),
      listDeploymentOutput: vi.fn(async () => [{ id: "out-1", deploymentId: item.id, sequence: 1, data: "ready\\n", createdAt: item.createdAt }]),
      cancelDeployment: vi.fn(async () => ({ ...item, status: "CANCELLED" as const })),
    };
    render(<DeploymentPage context={{ projectId: "project-1", runId: "run-1" }} client={client} />);
    await waitFor(() => expect(client.listDeployments).toHaveBeenCalledWith("project-1", "run-1", expect.any(AbortSignal)));
    await waitFor(() => expect(client.listDeploymentOutput).toHaveBeenCalledWith("project-1", "run-1", "deployment-1", 0, expect.any(AbortSignal)));
    expect(screen.getByRole("link", { name: "返回 Run" })).toHaveAttribute("href", "#/runs/run-1");
    expect(screen.getByLabelText("部署输出")).toHaveTextContent("ready");
  });

  it("cancels through the same scoped context", async () => {
    const client = { listDeployments: vi.fn(async () => [item]), listDeploymentOutput: vi.fn(async () => []), cancelDeployment: vi.fn(async () => ({ ...item, status: "CANCELLED" as const })) };
    render(<DeploymentPage context={{ projectId: "project-1", runId: "run-1" }} client={client} />);
    await screen.findByText("deployment-1");
    fireEvent.click(screen.getByRole("button", { name: "取消部署" }));
    await waitFor(() => expect(client.cancelDeployment).toHaveBeenCalledWith("project-1", "run-1", "deployment-1", expect.any(String), expect.any(AbortSignal)));
  });
});
