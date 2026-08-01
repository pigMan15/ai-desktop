import { describe, expect, it } from "vitest";

import {
  isInteractiveAgentSessionClosedError,
  isInteractiveAgentOutputLimitError,
  isTerminalSessionMissingError,
  mergeAgentOutput,
} from "./agentOutput";

describe("mergeAgentOutput", () => {
  it("appends only new output events in sequence order", () => {
    const result = mergeAgentOutput(
      [
        {
          id: "out-1",
          jobId: "job-1",
          sequence: 1,
          kind: "message",
          payload: { text: "第一条" },
          createdAt: "2026-07-28T00:00:00Z",
        },
      ],
      [
        {
          id: "out-1",
          jobId: "job-1",
          sequence: 1,
          kind: "message",
          payload: { text: "第一条" },
          createdAt: "2026-07-28T00:00:00Z",
        },
        {
          id: "out-2",
          jobId: "job-1",
          sequence: 2,
          kind: "message",
          payload: { text: "第二条" },
          createdAt: "2026-07-28T00:00:01Z",
        },
      ],
    );

    expect(result.map((event) => event.id)).toEqual(["out-1", "out-2"]);
  });

  it("keeps a bounded recent scrollback for each agent job", () => {
    const result = mergeAgentOutput(
      Array.from({ length: 2_000 }, (_, index) => outputEvent("job-1", index + 1)),
      [outputEvent("job-1", 2_001), outputEvent("job-2", 1)],
    );

    expect(result.filter((event) => event.jobId === "job-1")).toHaveLength(2_000);
    expect(result.find((event) => event.jobId === "job-1" && event.sequence === 1)).toBeUndefined();
    expect(result.find((event) => event.jobId === "job-1" && event.sequence === 2_001)).toBeDefined();
    expect(result.find((event) => event.jobId === "job-2" && event.sequence === 1)).toBeDefined();
  });

  it("recognizes a Runtime conflict for an ended interactive session", () => {
    expect(
      isInteractiveAgentSessionClosedError(
        new Error("Runtime API /interactive-session/output failed with 409: session is not running"),
      ),
    ).toBe(true);
  });

  it("recognizes a non-fatal interactive output persistence limit", () => {
    expect(isInteractiveAgentOutputLimitError(new Error("AGENT_OUTPUT_LIMIT: interactive CLI output exceeded 1000000 bytes"))).toBe(true);
  });

  it("recognizes a missing desktop terminal session after a restart", () => {
    expect(isTerminalSessionMissingError(new Error("Terminal session not found: terminal-1"))).toBe(true);
  });
});

function outputEvent(jobId: string, sequence: number) {
  return {
    id: `${jobId}:out:${sequence}`,
    jobId,
    sequence,
    kind: "terminal_raw",
    payload: { text: String(sequence) },
    createdAt: "2026-07-29T00:00:00Z",
  };
}
