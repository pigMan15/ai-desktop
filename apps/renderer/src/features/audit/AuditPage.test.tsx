import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditPage } from "./AuditPage";

afterEach(cleanup);

describe("AuditPage", () => {
  it("loads and filters records through the URL-owned Run context", async () => {
    const client = { listRunAuditRecords: vi.fn(async () => []) };
    render(<AuditPage context={{ projectId: "project-1", runId: "run-1" }} client={client} />);
    await waitFor(() => expect(client.listRunAuditRecords).toHaveBeenCalledWith("project-1", "run-1", "", expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText("审计动作筛选"), { target: { value: "run.updated" } });
    fireEvent.click(screen.getByRole("button", { name: "查询审计" }));
    await waitFor(() => expect(client.listRunAuditRecords).toHaveBeenCalledWith("project-1", "run-1", "run.updated", expect.any(AbortSignal)));
  });
  it("显示审计哈希链并允许按动作筛选", () => {
    const onFilter = vi.fn();
    render(
      <AuditPage
        records={[
          {
            id: "audit-1",
            actor: { id: "human-1", type: "human", source: "runtime", trusted: true },
            action: "knowledge.candidate.published",
            resource: "knowledge-candidate:candidate-1",
            detail: { documentId: "document-1" },
            previousHash: null,
            recordHash: "hash-1",
            createdAt: "2026-07-28T00:00:00Z",
          },
        ]}
        onFilter={onFilter}
      />,
    );

    fireEvent.change(screen.getByLabelText("审计动作筛选"), {
      target: { value: "knowledge.candidate.published" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询审计" }));

    expect(onFilter).toHaveBeenCalledWith("knowledge.candidate.published");
    expect(screen.getByText("human-1")).toBeInTheDocument();
    expect(screen.getByText("hash-1")).toBeInTheDocument();
  });
});
