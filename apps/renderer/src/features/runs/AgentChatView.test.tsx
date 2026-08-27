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
    expect(screen.getByRole("button", { name: "允许" })).not.toBeDisabled();
  });
});


it("renders avatars and timestamps for messages", () => {
  const withTime = [
    { sequence: 1, kind: "message" as const, text: "hello", createdAt: "2026-08-12T01:02:00Z" },
    { sequence: 2, kind: "user" as const, text: "hi", createdAt: "2026-08-12T01:03:00Z" },
  ];
  render(
    <AgentChatView
      jobLabel="fake ? job-1"
      messages={withTime}
      permissions={[]}
      disabled={true}
      onSend={vi.fn()}
      onDecide={vi.fn()}
    />,
  );
  expect(document.querySelectorAll(".agent-chat-avatar")).toHaveLength(2);
  expect(document.querySelectorAll(".agent-chat-time")).toHaveLength(2);
  expect(screen.getByText("hello")).toBeInTheDocument();
  expect(screen.getByText("hi")).toBeInTheDocument();
});


describe("AgentChatView permission decisions", () => {
  it("disables approval decisions when permissionDisabled", () => {
    render(
      <AgentChatView
        jobLabel="fake · job-1"
        messages={messages}
        permissions={permissions}
        disabled={false}
        permissionDisabled={true}
        onSend={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "允许" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  });
});
