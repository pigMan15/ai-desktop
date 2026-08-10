import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentChatView } from "./AgentChatView";

afterEach(cleanup);

const messages = [
  { sequence: 1, kind: "message" as const, text: "Agent：你好" },
  { sequence: 2, kind: "permission" as const, text: "权限请求（PENDING）：src/a.ts" },
];

const permissions = [
  {
    id: "perm-1",
    jobId: "job-1",
    runId: "run-1",
    permissionType: "write_file" as const,
    target: "src/a.ts",
    details: {},
    status: "PENDING" as const,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
  },
];

describe("AgentChatView", () => {
  it("sends a message and decides a permission", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentChatView
        jobLabel="fake · job-1"
        messages={messages}
        permissions={permissions}
        disabled={false}
        onSend={onSend}
        onDecide={onDecide}
      />,
    );

    fireEvent.change(screen.getByLabelText("聊天输入"), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("继续");

    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(onDecide).toHaveBeenCalledWith("perm-1", "allow");
  });

  it("disables input and decisions when disabled", () => {
    render(
      <AgentChatView
        jobLabel="fake · job-1"
        messages={messages}
        permissions={permissions}
        disabled={true}
        onSend={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("聊天输入")).toBeDisabled();
    expect(screen.getByRole("button", { name: "允许" })).toBeDisabled();
  });
});
