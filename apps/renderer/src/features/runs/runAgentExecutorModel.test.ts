import { describe, expect, it } from "vitest";
import type { AgentJobSummary, AgentOutputSummary } from "../../app/runtimeClient";
import { agentChatMessages, agentViewportOutput, isConversationalJob, selectAgentJob } from "./runAgentExecutorModel";

const job = (
  id: string,
  status: AgentJobSummary["status"],
  updatedAt: string,
): AgentJobSummary => ({
  id,
  runId: "run-1",
  nodeId: "node-1",
  provider: "codex",
  status,
  mode: "interactive",
  command: ["codex"],
  cwd: "G:\\Project\\demo",
  createdAt: updatedAt,
  updatedAt,
});

describe("selectAgentJob", () => {
  const jobs = [
    job("job-done", "COMPLETED", "2026-08-07T10:00:00.000Z"),
    job("job-running-old", "RUNNING", "2026-08-07T11:00:00.000Z"),
    job("job-running-new", "QUEUED", "2026-08-07T12:00:00.000Z"),
  ];

  it("selects the requested Job when it exists", () => {
    expect(selectAgentJob(jobs, "job-done")?.id).toBe("job-done");
  });

  it("selects the newest active Job when the requested Job is unavailable", () => {
    expect(selectAgentJob(jobs, "missing")?.id).toBe("job-running-new");
    expect(selectAgentJob(jobs, null)?.id).toBe("job-running-new");
  });

  it("falls back to the most recently updated Job", () => {
    const completedJobs = [
      job("job-old", "FAILED", "2026-08-07T09:00:00.000Z"),
      job("job-new", "COMPLETED", "2026-08-07T10:00:00.000Z"),
    ];

    expect(selectAgentJob(completedJobs, null)?.id).toBe("job-new");
    expect(selectAgentJob([], null)).toBeNull();
  });
});

describe("agentViewportOutput", () => {
  const persisted: AgentOutputSummary[] = [
    {
      id: "output-3",
      jobId: "job-2",
      sequence: 3,
      kind: "stdout",
      payload: { text: "third" },
      createdAt: "2026-08-07T10:00:03.000Z",
    },
    {
      id: "output-1",
      jobId: "job-2",
      sequence: 1,
      kind: "stdout",
      payload: { data: "first" },
      createdAt: "2026-08-07T10:00:01.000Z",
    },
    {
      id: "output-2",
      jobId: "job-2",
      sequence: 2,
      kind: "event",
      payload: { status: "working" },
      createdAt: "2026-08-07T10:00:02.000Z",
    },
  ];

  it("uses live PTY output as the authoritative stream while present", () => {
    const live = [{ sequence: 8, data: "live" }];

    expect(agentViewportOutput("job-2", persisted, { "job-2": live })).toEqual(live);
  });

  it("maps and sorts persisted output when no live PTY output exists", () => {
    expect(agentViewportOutput("job-2", persisted, {})).toEqual([
      { sequence: 1, data: "first" },
      { sequence: 2, data: JSON.stringify({ status: "working" }) },
      { sequence: 3, data: "third" },
    ]);
  });
});


describe("agent chat model", () => {
  it("detects conversational jobs from metadata", () => {
    expect(
      isConversationalJob({
        ...job("job-1", "AWAITING_INPUT", "2026-08-11T00:00:00.000Z"),
        metadata: { conversational: true },
      }),
    ).toBe(true);
    expect(isConversationalJob(job("job-2", "COMPLETED", "2026-08-11T00:00:00.000Z"))).toBe(false);
  });

  it("builds chat messages from acp output events", () => {
    const persisted: AgentOutputSummary[] = [
      { id: "o1", jobId: "job-1", sequence: 1, kind: "acp.turn", payload: {}, createdAt: "2026-08-11T00:00:00.000Z" },
      { id: "o2", jobId: "job-1", sequence: 2, kind: "acp.message", payload: { text: "你好" }, createdAt: "2026-08-11T00:00:01.000Z" },
      { id: "o3", jobId: "job-1", sequence: 3, kind: "acp.permission", payload: { status: "PENDING", target: "src/a.ts", permissionType: "write_file" }, createdAt: "2026-08-11T00:00:02.000Z" },
      { id: "o4", jobId: "other", sequence: 4, kind: "acp.message", payload: { text: "x" }, createdAt: "2026-08-11T00:00:03.000Z" },
    ];
    const messages = agentChatMessages("job-1", persisted);
    expect(messages).toHaveLength(3);
    expect(messages[1].kind).toBe("message");
    expect(messages[1].text).toBe("你好");
    expect(messages[2].kind).toBe("permission");
    expect(messages[2].text).toContain("src/a.ts");
  });
});
