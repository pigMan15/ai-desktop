import { describe, expect, it } from "vitest";

import { mergeAgentOutput } from "./agentOutput";

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
});
