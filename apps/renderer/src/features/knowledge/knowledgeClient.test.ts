import { afterEach, describe, expect, it, vi } from "vitest";

import { createKnowledgeClient } from "./knowledgeClient";

function jsonResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  } as Response;
}

const actor = { id: "user-1", type: "human" as const, source: "renderer" as const, trusted: true };

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { workflowRuntime?: unknown }).workflowRuntime;
});

describe("knowledgeClient", () => {
  it("lists and imports repositories with exact requests", async () => {
    const repository = { id: "repo-1", name: "物流知识库", status: "RULES_PENDING" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [repository] }))
      .mockResolvedValueOnce(jsonResponse(repository));
    vi.stubGlobal("fetch", fetchMock);
    const client = createKnowledgeClient("http://127.0.0.1:8765");

    await expect(client.listRepositories()).resolves.toEqual([repository]);
    await expect(
      client.importRepository({
        name: "物流知识库",
        rootPath: "D:/knowledge/logistics",
        autoApplyLowRisk: false,
        actor,
        now: "2026-08-10T00:00:00Z",
      }),
    ).resolves.toEqual(repository);

    const [listUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(listUrl).toBe("http://127.0.0.1:8765/knowledge-repositories");
    const [importUrl, importInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(importUrl).toBe("http://127.0.0.1:8765/knowledge-repositories/import");
    expect(importInit).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(importInit.body))).toMatchObject({
      name: "物流知识库",
      rootPath: "D:/knowledge/logistics",
      autoApplyLowRisk: false,
    });
  });

  it("discovers rules, confirms snapshots and updates settings", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId: "job-1", repositoryId: "repo-1", status: "QUEUED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "snap-1", status: "PROPOSED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "repo-1", status: "ACTIVE", revision: "2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "repo-1", autoApplyLowRisk: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createKnowledgeClient("http://127.0.0.1:8765");

    await expect(
      client.discoverRules("repo-1", { provider: "codex", actor, expectedRevision: "1", now: "t" }),
    ).resolves.toEqual({ jobId: "job-1", repositoryId: "repo-1", status: "QUEUED" });
    await expect(client.getRuleDiscoveryJob("repo-1", "job-1")).resolves.toEqual({
      id: "snap-1",
      status: "PROPOSED",
    });
    await expect(
      client.confirmRuleSnapshot("repo-1", "snap-1", {
        writablePaths: ["candidate/**"],
        protectedPaths: [".git/**"],
        indexFiles: ["INDEX.md"],
        routingFiles: [],
        templateFiles: [],
        validationCommands: [],
        summary: "rules",
        openQuestions: [],
        actor,
        expectedRevision: "1",
        now: "t",
      }),
    ).resolves.toEqual({ id: "repo-1", status: "ACTIVE", revision: "2" });
    await expect(
      client.updateSettings("repo-1", { autoApplyLowRisk: true, actor, expectedRevision: "2", now: "t" }),
    ).resolves.toEqual({ id: "repo-1", autoApplyLowRisk: true });

    const [, discoverInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(discoverInit).toMatchObject({ method: "POST" });
    const [confirmUrl] = fetchMock.mock.calls[2] as unknown as [string];
    expect(confirmUrl).toBe("http://127.0.0.1:8765/knowledge-repositories/repo-1/rule-snapshots/snap-1/confirm");
    const [settingsUrl] = fetchMock.mock.calls[3] as unknown as [string];
    expect(settingsUrl).toBe("http://127.0.0.1:8765/knowledge-repositories/repo-1/settings");
  });

  it("runs the change set lifecycle through scoped endpoints", async () => {
    const changeSet = { id: "cs-1", status: "DRAFT", revision: "1" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(changeSet))
      .mockResolvedValueOnce(jsonResponse({ jobId: "job-1", changeSetId: "cs-1", status: "QUEUED" }))
      .mockResolvedValueOnce(jsonResponse({ ...changeSet, status: "APPLIED" }))
      .mockResolvedValueOnce(jsonResponse({ commitHash: "abc123", branch: "main", committedPaths: ["candidate/x.md"] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createKnowledgeClient("http://127.0.0.1:8765");

    await expect(
      client.createChangeSet("project/1", "run/1", {
        repositoryId: "repo-1",
        artifactIds: ["artifact-1"],
        provider: "fake",
        mode: "preview",
        actor,
        now: "t",
      }),
    ).resolves.toEqual(changeSet);
    await expect(
      client.generateChangeSet("project/1", "run/1", "cs-1", { actor, expectedRevision: "1", now: "t" }),
    ).resolves.toEqual({ jobId: "job-1", changeSetId: "cs-1", status: "QUEUED" });
    await expect(
      client.applyChangeSet("project/1", "run/1", "cs-1", { actor, expectedRevision: "2", now: "t" }),
    ).resolves.toEqual({ ...changeSet, status: "APPLIED" });
    await expect(
      client.gitCommit("project/1", "run/1", "cs-1", {
        title: "knowledge: add x",
        body: "",
        paths: ["candidate/x.md"],
        actor,
        expectedRevision: "3",
        expectedRepositoryRevision: "2",
        now: "t",
      }),
    ).resolves.toEqual({ commitHash: "abc123", branch: "main", committedPaths: ["candidate/x.md"] });

    const [createUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(createUrl).toBe("http://127.0.0.1:8765/projects/project%2F1/runs/run%2F1/knowledge-change-sets");
    const [commitUrl] = fetchMock.mock.calls[3] as unknown as [string];
    expect(commitUrl).toBe(
      "http://127.0.0.1:8765/projects/project%2F1/runs/run%2F1/knowledge-change-sets/cs-1/git/commit",
    );
  });
});
