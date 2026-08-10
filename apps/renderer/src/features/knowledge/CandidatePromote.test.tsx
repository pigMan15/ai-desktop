import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CandidatePromote } from "./CandidatePromote";

afterEach(cleanup);

function makeClient() {
  const listCandidateKnowledge = vi.fn().mockResolvedValue({
    items: [{ path: "candidate/release-check.md", title: "release-check 设计", sizeBytes: 100 }],
  });
  const promoteCandidateKnowledge = vi.fn().mockResolvedValue({ id: "repo-1" });
  return {
    listCandidateKnowledge,
    promoteCandidateKnowledge,
  } as never;
}

describe("CandidatePromote", () => {
  it("promotes a candidate to the default main/ target", async () => {
    const client = makeClient() as any;
    const onPromoted = vi.fn();
    render(
      <CandidatePromote
        client={client}
        repositoryId="repo-1"
        expectedRevision="3"
        onPromoted={onPromoted}
      />,
    );

    await screen.findByText("candidate/release-check.md");
    fireEvent.click(screen.getByRole("button", { name: "转正" }));
    fireEvent.click(screen.getByRole("button", { name: "确认转正" }));

    await waitFor(() => expect(client.promoteCandidateKnowledge).toHaveBeenCalledTimes(1));
    const payload = client.promoteCandidateKnowledge.mock.calls[0];
    expect(payload[0]).toBe("repo-1");
    expect(payload[1].path).toBe("candidate/release-check.md");
    expect(payload[1].targetPath).toBe("main/release-check.md");
    expect(payload[1].expectedRevision).toBe("3");
    expect(onPromoted).toHaveBeenCalledTimes(1);
  });
});
