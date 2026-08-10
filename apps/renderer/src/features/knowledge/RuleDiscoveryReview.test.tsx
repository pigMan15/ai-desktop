import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuleDiscoveryReview } from "./RuleDiscoveryReview";

afterEach(cleanup);

const baseSnapshot = {
  id: "snapshot-1",
  repositoryId: "repo-1",
  revision: "2",
  headCommit: "abc",
  discoveredFiles: [
    { path: "KNOWLEDGE-RULES.md", category: "RULE", hash: "h1", sizeBytes: 10, purpose: "规则" },
    { path: "README.md", category: "RULE", hash: "h2", sizeBytes: 10, purpose: "规则" },
  ],
  writablePaths: ["main/**"],
  protectedPaths: [".git/**"],
  indexFiles: ["INDEX.md"],
  routingFiles: ["ROUTING.md"],
  templateFiles: ["template/**/*.md"],
  validationCommands: [],
  summary: "规则发现完成",
  openQuestions: ["[待确认] INDEX.md 引用缺失"],
  source: "agent-discovery" as const,
  contentHash: "ch",
  status: "PROPOSED" as const,
  confirmedBy: null,
  confirmedAt: null,
};

describe("RuleDiscoveryReview", () => {
  it("blocks confirm until open questions are acknowledged", () => {
    const onConfirm = vi.fn();
    render(
      <RuleDiscoveryReview
        snapshot={baseSnapshot}
        expectedRevision="1"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirmButton = screen.getByRole("button", { name: "确认规则" });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const payload = onConfirm.mock.calls[0][0];
    expect(payload.openQuestions).toEqual([]);
    expect(payload.summary).toContain("已知悉 1 项待确认事项");
    expect(payload.summary).toContain("[待确认] INDEX.md 引用缺失");
  });

  it("allows direct confirm when there are no open questions", () => {
    const onConfirm = vi.fn();
    render(
      <RuleDiscoveryReview
        snapshot={{ ...baseSnapshot, openQuestions: [] }}
        expectedRevision="1"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const confirmButton = screen.getByRole("button", { name: "确认规则" });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].openQuestions).toEqual([]);
  });
});
