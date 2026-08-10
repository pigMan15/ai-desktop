import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeClientError,
  createRuntimeClient,
  loadWorkbenchState,
  restoreWorkbenchState,
} from "./runtimeClient";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { workflowRuntime?: unknown }).workflowRuntime;
});

describe("runtimeClient", () => {
  it("loads a scoped run overview and executes an action with exact browser requests", async () => {
    const overview = scopedRunOverview();
    const actionResponse = {
      projection: projection("run/one", "2", "IN_PROGRESS"),
      emittedEvents: [{
        id: "event-2",
        runId: "run/one",
        type: "NODE_STARTED",
        nodeId: "plan",
        actor: { id: "human-1", type: "human", source: "renderer", trusted: true },
        payload: {},
        createdAt: "2026-08-06T00:01:00Z",
        revision: "2",
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse(actionResponse));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    const client = createRuntimeClient("http://127.0.0.1:8765");
    const actionBody = {
      actionId: "complete:plan",
      expectedRevision: "7",
      actor: { id: "human-1", type: "human" as const, source: "renderer" as const, trusted: true },
      payload: { artifactPath: "docs/plan.md" },
    };

    await expect(client.getProjectRunOverview("project/a", "run/one", signal))
      .resolves.toEqual(overview);
    await expect(client.executeProjectRunAction("project/a", "run/one", actionBody, signal))
      .resolves.toEqual(actionResponse);

    const [overviewUrl, overviewInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(overviewUrl).toBe(
      "http://127.0.0.1:8765/projects/project%2Fa/runs/run%2Fone/overview",
    );
    expect(overviewInit).toMatchObject({ method: "GET", signal });
    const [actionUrl, actionInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(actionUrl).toBe(
      "http://127.0.0.1:8765/projects/project%2Fa/runs/run%2Fone/actions",
    );
    expect(actionInit).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
    });
    expect(actionInit.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.parse(String(actionInit.body))).toEqual(actionBody);
  });

  it("sends scoped run detail requests through the Desktop bridge", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(scopedRunOverview())
      .mockResolvedValueOnce({ projection: projection("run/one", "2", "IN_PROGRESS"), emittedEvents: [] });
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: { request },
    });
    const client = createRuntimeClient("http://unused");
    const body = {
      actionId: "complete:plan",
      expectedRevision: "7",
      actor: { id: "human-1", type: "human" as const, source: "renderer" as const, trusted: true },
      payload: { artifactPath: "docs/plan.md" },
    };

    await client.getProjectRunOverview("project/a", "run/one", new AbortController().signal);
    await client.executeProjectRunAction(
      "project/a",
      "run/one",
      body,
      new AbortController().signal,
    );

    expect(request).toHaveBeenNthCalledWith(1, {
      path: "/projects/project%2Fa/runs/run%2Fone/overview",
      method: "GET",
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      path: "/projects/project%2Fa/runs/run%2Fone/actions",
      method: "POST",
      body,
    });
  });

  it.each([
    [404, "RUN_NOT_FOUND_IN_PROJECT"],
    [409, "REVISION_CONFLICT"],
    [409, "RUN_ARCHIVED"],
    [503, "RUN_REARCHITECTURE_MAINTENANCE"],
  ])("preserves scoped run detail error %s %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code,
      message: `Runtime error: ${code}`,
      details: { runId: "run-1" },
      correlationId: `corr-${code}`,
    }), { status })));

    const client = createRuntimeClient("http://127.0.0.1:8765");
    const request = code === "REVISION_CONFLICT" || code === "RUN_ARCHIVED"
      ? client.executeProjectRunAction("project-1", "run-1", {
          actionId: "complete:plan",
          expectedRevision: "7",
          actor: { id: "human-1", type: "human", source: "renderer", trusted: true },
        })
      : client.getProjectRunOverview("project-1", "run-1");
    const error = await request.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect(error).toMatchObject({
      status,
      code,
      message: `Runtime error: ${code}`,
      details: { runId: "run-1" },
      correlationId: `corr-${code}`,
    });
  });

  it("serializes project run list filters with repeated statuses and an opaque cursor", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    const result = await createRuntimeClient("http://127.0.0.1:8765").listProjectRuns(
      "project/alpha",
      {
        status: ["IN_PROGRESS", "BLOCKED"],
        workflowVersionId: "workflow/version 1",
        workspacePath: "G:/Work/alpha & beta",
        q: "release candidate",
        cursor: "eyJvZmZzZXQiOjEwfQ==&opaque=yes",
        limit: 25,
      },
      signal,
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "http://127.0.0.1:8765/projects/project%2Falpha/runs?status=IN_PROGRESS&status=BLOCKED&workflowVersionId=workflow%2Fversion+1&workspacePath=G%3A%2FWork%2Falpha+%26+beta&q=release+candidate&cursor=eyJvZmZzZXQiOjEwfQ%3D%3D%26opaque%3Dyes&limit=25",
    );
    expect(init).toMatchObject({ method: "GET", signal });
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it("creates a project-scoped run with the exact body and idempotency header", async () => {
    const response = scopedCreateRunResponse();
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    const body = {
      workflowVersionId: "workflow-version-1",
      title: "Release candidate",
      taskGoal: "Ship safely",
      parameters: { tier: "staging" },
      executionWorkspace: { path: "G:/Work/release", mode: "write" as const },
      actor: { id: "human-1", type: "human" as const, source: "renderer" as const, trusted: true },
    };

    const result = await createRuntimeClient("http://127.0.0.1:8765").createProjectRun(
      "project/alpha",
      "create-run-1",
      body,
      signal,
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/projects/project%2Falpha/runs");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "create-run-1",
      },
      signal,
    });
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(result).toEqual(response);
  });

  it("sends serializable request options through the Desktop bridge", async () => {
    const request = vi.fn(async () => ({ items: [], nextCursor: null }));
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: { request },
    });
    const signal = new AbortController().signal;

    await createRuntimeClient("http://unused").listProjectRuns(
      "project-1",
      { status: ["DONE"], cursor: "opaque+/=" },
      signal,
    );

    expect(request).toHaveBeenCalledWith({
      path: "/projects/project-1/runs?status=DONE&cursor=opaque%2B%2F%3D",
      method: "GET",
    });
  });

  it("unwraps a structured Runtime failure from the Desktop bridge", async () => {
    const request = vi.fn(async () => ({
      __workflowPlatformRuntimeIpc: "workflow-platform.runtime-ipc.v1#7f8c2a61",
      kind: "runtime-error",
      error: {
        status: 423,
        code: "WORKSPACE_RECOVERY_REQUIRED",
        message: "Workspace lease is not active",
        details: { runId: "run-1" },
        correlationId: "corr-desktop-1",
      },
    }));
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: { request },
    });

    const error = await createRuntimeClient("http://unused")
      .listProjectRuns("project-1", {})
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect(error).toMatchObject({
      status: 423,
      code: "WORKSPACE_RECOVERY_REQUIRED",
      message: "Workspace lease is not active",
      details: { runId: "run-1" },
      correlationId: "corr-desktop-1",
    });
  });

  it("keeps generic Desktop bridge rejections as DESKTOP_ERROR", async () => {
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: { request: vi.fn(async () => { throw new Error("IPC channel closed"); }) },
    });

    await expect(
      createRuntimeClient("http://unused").listProjectRuns("project-1", {}),
    ).rejects.toMatchObject({
      status: null,
      code: "DESKTOP_ERROR",
      message: "IPC channel closed",
      correlationId: null,
    });
  });

  it.each([
    [
      "a malformed runtime-error",
      {
        __workflowPlatformRuntimeIpc: "workflow-platform.runtime-ipc.v1#7f8c2a61",
        kind: "runtime-error",
        error: { status: 409, message: "Missing code", correlationId: "corr-malformed" },
      },
    ],
    [
      "an unknown kind",
      {
        __workflowPlatformRuntimeIpc: "workflow-platform.runtime-ipc.v1#7f8c2a61",
        kind: "partial-success",
        value: { items: [], nextCursor: null },
      },
    ],
    [
      "an unsupported version",
      {
        __workflowPlatformRuntimeIpc: "workflow-platform.runtime-ipc.v2#7f8c2a61",
        kind: "success",
        value: { items: [], nextCursor: null },
      },
    ],
  ])("rejects Desktop envelopes with %s", async (_label, envelope) => {
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: { request: vi.fn(async () => envelope) },
    });

    await expect(
      createRuntimeClient("http://unused").listProjectRuns("project-1", {}),
    ).rejects.toMatchObject({
      status: null,
      code: "DESKTOP_ERROR",
      correlationId: null,
    });
  });

  it("accepts an untagged Desktop payload for legacy bridge compatibility", async () => {
    const payload = { items: [], nextCursor: "legacy-cursor" };
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: { request: vi.fn(async () => payload) },
    });

    await expect(
      createRuntimeClient("http://unused").listProjectRuns("project-1", {}),
    ).resolves.toEqual(payload);
  });

  it.each([
    ["canonical", { code: "PROJECT_ARCHIVED", message: "Project is archived", details: { projectId: "project-1" }, correlationId: "corr-1" }],
    ["FastAPI", { detail: { code: "REVISION_CONFLICT", message: "Revision changed", correlationId: "corr-2" } }],
  ])("parses %s Runtime errors into RuntimeClientError", async (_label, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 409 })),
    );

    const error = await createRuntimeClient("http://127.0.0.1:8765")
      .listProjectRuns("project-1", {})
      .catch((caught: unknown) => caught);

    const runtimeError = "detail" in payload ? payload.detail : payload;
    expect(error).toBeInstanceOf(RuntimeClientError);
    expect(error).toMatchObject({
      status: 409,
      code: runtimeError.code,
      message: runtimeError.message,
      details: "details" in runtimeError ? runtimeError.details : undefined,
      correlationId: runtimeError.correlationId,
    });
  });

  it("preserves generic network messages and AbortError identity", async () => {
    const client = createRuntimeClient("http://127.0.0.1:8765");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await expect(client.listProjectRuns("project-1", {})).rejects.toMatchObject({
      status: null,
      code: "NETWORK_ERROR",
      message: "Failed to fetch",
      correlationId: null,
    });

    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortError; }));
    await expect(client.listProjectRuns("project-1", {})).rejects.toBe(abortError);
  });

  it("binds a project workflow with POST", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ workflowBindingStatus: "bound" }));
    vi.stubGlobal("fetch", fetchMock);

    await createRuntimeClient("http://127.0.0.1:8765").bindProjectWorkflow(
      "project-demo",
      "workflow-demo",
      "workflow-version-demo",
      "2026-08-04T00:00:00Z",
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/projects/project-demo/workflow-binding");
    expect(init.method).toBe("POST");
  });

  it("loads and updates project concurrency and workspace occupancy", async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse(url.pathname.endsWith("/workspaces") ? [] : { maxActiveRuns: 3, maxActiveAgents: 2 });
    }));

    const client = createRuntimeClient("http://127.0.0.1:8765");
    await client.getProjectConcurrency("project/a");
    await client.updateProjectConcurrency("project/a", { maxActiveRuns: 4, maxActiveAgents: 3 }, "2026-08-06T00:00:00Z");
    await client.listProjectWorkspaces("project/a");
    await client.createProjectWorktree("project/a", "run-123", "run/123");

    expect(calls.map((call) => call.path)).toEqual([
      "/projects/project%2Fa/concurrency",
      "/projects/project%2Fa/concurrency",
      "/projects/project%2Fa/workspaces",
      "/projects/project%2Fa/worktrees",
    ]);
    expect(calls[1]).toMatchObject({
      method: "PUT",
      body: { maxActiveRuns: 4, maxActiveAgents: 3, actor: { type: "human", trusted: true } },
    });
    expect(calls[3]).toMatchObject({
      method: "POST",
      body: { name: "run-123", branchName: "run/123", baseRef: "HEAD" },
    });
  });

  it("在桌面环境通过 preload 代理调用 Runtime，避免 Renderer 持有本地令牌", async () => {
    const request = vi.fn(async () => ({ status: "ok", service: "workflow-runtime" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: {
        request,
      },
    });

    const result = await createRuntimeClient("http://127.0.0.1:8765").health();

    expect(result).toEqual({ status: "ok", service: "workflow-runtime" });
    expect(request).toHaveBeenCalledWith({ path: "/health" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the live Runtime before reporting an uninitialized workspace", async () => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "ok", service: "workflow-runtime" })),
    );

    const state = await loadWorkbenchState();

    expect(state.connection).toBe("connected");
    expect(state.workspaceStatus).toBe("uninitialized");
    expect(state.projection).toBeNull();
  });

  it("includes the Runtime error detail when an artifact operation is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "ARTIFACT_SPEC_MISMATCH: path does not match" }), {
          status: 400,
        }),
      ),
    );

    await expect(
      createRuntimeClient("http://127.0.0.1:8765").scanNodeArtifacts(
        "project-1",
        "run-1",
        "plan",
        "1",
        "2026-07-30T00:00:00Z",
      ),
    ).rejects.toThrow("ARTIFACT_SPEC_MISMATCH: path does not match");
  });

  it("uses the configured Runtime address only for health checks during startup", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return jsonResponse({ status: "ok", service: "workflow-runtime" });
      }),
    );

    const state = await loadWorkbenchState("http://127.0.0.1:9900");

    expect(state.connection).toBe("connected");
    expect(calls).toEqual(["http://127.0.0.1:9900/health"]);
  });

  it("reads Codex and Claude CLI diagnostics from the Runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            id: "codex",
            executable: "codex.cmd",
            available: true,
            path: "C:\\Tools\\codex.cmd",
            version: "1.0.0",
            message: "已检测到 Codex CLI。",
          },
          {
            id: "claude",
            executable: "claude.cmd",
            available: false,
            path: null,
            version: null,
            message: "未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。",
          },
        ]),
      ),
    );

    const diagnostics = await createRuntimeClient("http://127.0.0.1:8765").listAgentProviders();

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.id).toBe("codex");
    expect(diagnostics[1]?.available).toBe(false);
  });

  it("downloads the redacted diagnostic support bundle from the Runtime", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        return jsonResponse({
          fileName: "workflow-platform-diagnostics.json",
          mediaType: "application/json",
          content: "{\"title\":\"诊断支持包\"}",
        });
      }),
    );

    const bundle = await createRuntimeClient(
      "http://127.0.0.1:8765",
    ).getDiagnosticSupportBundle();

    expect(bundle).toEqual({
      fileName: "workflow-platform-diagnostics.json",
      mediaType: "application/json",
      content: "{\"title\":\"诊断支持包\"}",
    });
    expect(calls).toEqual(["/diagnostics/support-bundle"]);
  });

  it("exports a workflow as Canonical JSON or Generic YAML", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        return jsonResponse({
          fileName: "demo-workflow.yaml",
          mediaType: "application/x-yaml",
          content: "id: demo-workflow\n",
        });
      }),
    );

    const client = createRuntimeClient("http://127.0.0.1:8765");
    const canonical = await client.exportWorkflowVersion("workflow-version-1", "canonical-json");
    const genericYaml = await client.exportWorkflowVersion("workflow-version-1", "generic-yaml");

    expect(canonical.fileName).toBe("demo-workflow.yaml");
    expect(genericYaml.content).toContain("id: demo-workflow");
    expect(calls).toEqual([
      "/workflow-versions/workflow-version-1/export?format=canonical-json",
      "/workflow-versions/workflow-version-1/export?format=generic-yaml",
    ]);
  });

  it("archives a project through a trusted human Runtime action", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({
          projectId: "project-demo",
          archived: true,
          archivedAt: "2026-07-28T00:00:00Z",
        });
      }),
    );

    const result = await createRuntimeClient("http://127.0.0.1:8765").archiveProject(
      "project-demo",
      "2026-07-28T00:00:00Z",
    );

    expect(result.archived).toBe(true);
    expect(calls).toEqual([
      {
        path: "/projects/project-demo/archive",
        body: {
          actor: { id: "renderer-human", type: "human", source: "runtime", trusted: true },
          now: "2026-07-28T00:00:00Z",
        },
      },
    ]);
  });

  it("cleans orphan terminal sessions through the run recovery endpoint", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ runId: "run-demo", cleanedSessionIds: ["terminal-orphan"] });
      }),
    );

    const result = await createRuntimeClient("http://127.0.0.1:8765").cleanupOrphanTerminalSessions(
      "project-1",
      "run-demo",
      "2026-07-28T00:00:00Z",
    );

    expect(result).toEqual({
      runId: "run-demo",
      cleanedSessionIds: ["terminal-orphan"],
    });
    expect(calls).toEqual([
      {
        path: "/projects/project-1/runs/run-demo/recovery/cleanup-orphan-terminals",
        body: { now: "2026-07-28T00:00:00Z" },
      },
    ]);
  });

  it("reads persisted terminal sessions and scrollback from the Runtime", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        if (url.pathname.endsWith("/output")) {
          return jsonResponse([
            {
              sequence: 1,
              stream: "stdout",
              data: "已脱敏的历史输出\r\n",
              createdAt: "2026-07-28T00:00:00Z",
            },
          ]);
        }
        return jsonResponse([
          {
            id: "terminal-history",
            runId: "run-demo",
            nodeId: "plan",
            kind: "shell",
            status: "stopped",
            cwd: "G:\\Project\\demo",
            pid: null,
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:01:00Z",
          },
        ]);
      }),
    );

    const client = createRuntimeClient("http://127.0.0.1:8765");
    const sessions = await client.listTerminalSessions("project-1", "run-demo");
    const output = await client.listTerminalOutput("project-1", "run-demo", "terminal-history");

    expect(sessions[0]?.status).toBe("stopped");
    expect(output[0]?.data).toContain("历史输出");
    expect(calls).toEqual([
      "/projects/project-1/runs/run-demo/terminals",
      "/projects/project-1/runs/run-demo/terminals/terminal-history/output?afterSequence=0",
    ]);
  });

  it("calls the knowledge and audit Runtime endpoints with trusted human actions", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname + url.search,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse([]);
      }),
    );

    const client = createRuntimeClient("http://127.0.0.1:8765");
    await client.createKnowledgeCandidate(
      "Gate 证据规范",
      "每个 Gate 决策都要有证据。",
      "run:run-1",
      "2026-07-28T00:00:00Z",
    );
    await client.reviewKnowledgeCandidate(
      "candidate-1",
      "approved",
      "审核通过",
      "2026-07-28T00:00:00Z",
    );
    await client.publishKnowledgeCandidate("candidate-1", "2026-07-28T00:00:00Z");
    await client.listKnowledgeCandidates();
    await client.searchKnowledge("Gate");
    await client.listAuditRecords({ action: "knowledge.candidate.published" });

    expect(calls.map((call) => call.path)).toEqual([
      "/knowledge/candidates",
      "/knowledge/candidates/candidate-1/review",
      "/knowledge/candidates/candidate-1/publish",
      "/knowledge/candidates",
      "/knowledge/search?query=Gate",
      "/audit-records?action=knowledge.candidate.published",
    ]);
    expect(calls[0]?.body).toMatchObject({
      title: "Gate 证据规范",
      actor: { type: "human", trusted: true },
    });
    expect(calls[1]?.body).toMatchObject({
      decision: "approved",
      comment: "审核通过",
      actor: { type: "human", trusted: true },
    });
  });

  it("starts, reads, reviews, and publishes governed knowledge syntheses", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname + url.search,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse([]);
      }),
    );

    const client = createRuntimeClient("http://127.0.0.1:8765");
    await client.startKnowledgeSynthesis("candidate-1", "codex", "2026-07-28T00:00:00Z");
    await client.listKnowledgeSyntheses();
    await client.recordKnowledgeSynthesisFeedback(
      "synthesis-1",
      "请保留回滚证据。",
      "2026-07-28T00:00:01Z",
    );
    await client.publishKnowledgeSynthesis("synthesis-1", "2026-07-28T00:00:02Z");
    await client.listKnowledgeSynthesisOutput("synthesis-1", 2);

    expect(calls.map((call) => call.path)).toEqual([
      "/knowledge/candidates/candidate-1/syntheses",
      "/knowledge/syntheses",
      "/knowledge/syntheses/synthesis-1/feedback",
      "/knowledge/syntheses/synthesis-1/publish",
      "/knowledge/syntheses/synthesis-1/output?afterSequence=2",
    ]);
    expect(calls[0]?.body).toMatchObject({
      provider: "codex",
      actor: { type: "human", trusted: true },
    });
    expect(calls[2]?.body).toMatchObject({
      feedback: "请保留回滚证据。",
      actor: { type: "human", trusted: true },
    });
  });

  it("starts and observes a Runtime-governed deployment without sending a shell command", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname + url.search,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse([]);
      }),
    );

    const client = createRuntimeClient("http://127.0.0.1:8765");
    await client.startDeployment("project-1", "run-1", "deploy", "7", "2026-07-28T00:00:00Z");
    await client.listDeployments("project-1", "run-1");
    await client.listDeploymentOutput("project-1", "run-1", "deployment-1", 3);
    await client.cancelDeployment("project-1", "run-1", "deployment-1", "2026-07-28T00:00:01Z");

    expect(calls.map((call) => call.path)).toEqual([
      "/projects/project-1/runs/run-1/deployments",
      "/projects/project-1/runs/run-1/deployments",
      "/projects/project-1/runs/run-1/deployments/deployment-1/output?afterSequence=3",
      "/projects/project-1/runs/run-1/deployments/deployment-1/cancel",
    ]);
    expect(calls[0]?.body).toEqual({
      nodeId: "deploy",
      actor: { id: "renderer-human", type: "human", source: "runtime", trusted: true },
      expectedRevision: "7",
      now: "2026-07-28T00:00:00Z",
    });
  });

  it("starts an interactive Agent and records its terminal session, input, output, and finish state", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname + url.search,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url.pathname.endsWith("/interactive-session/output")) {
          return jsonResponse([{ id: "out-1", jobId: "job-1", sequence: 1, kind: "terminal_raw", payload: { text: "需要确认\r\n" }, createdAt: "2026-07-29T00:00:00Z" }]);
        }
        return jsonResponse({ id: "job-1", status: "RUNNING" });
      }),
    );

    const client = createRuntimeClient("http://127.0.0.1:8765");
    await client.startAgentJob("project-1", "run-1", "plan", "codex", "继续开发", "2026-07-29T00:00:00Z", "interactive");
    await client.startInteractiveAgentSession("project-1", "run-1", "job-1", "terminal-1", 1234, "2026-07-29T00:00:01Z");
    await client.recordInteractiveAgentInput("project-1", "run-1", "job-1", "继续", "2026-07-29T00:00:02Z");
    await client.appendInteractiveAgentOutput("project-1", "run-1", "job-1", [{ data: "需要确认\r\n" }], "2026-07-29T00:00:03Z");
    await client.finishInteractiveAgentSession("project-1", "run-1", "job-1", "COMPLETED", "完成", null, "2026-07-29T00:00:04Z");
    await client.getInteractiveAgentSession("project-1", "run-1", "job-1");
    await client.continueInteractiveAgent("project-1", "run-1", "job-1", "2026-07-29T00:00:05Z");

    expect(calls.map((call) => call.path)).toEqual([
      "/projects/project-1/runs/run-1/agents",
      "/projects/project-1/runs/run-1/agents/job-1/interactive-session/start",
      "/projects/project-1/runs/run-1/agents/job-1/interactive-session/input",
      "/projects/project-1/runs/run-1/agents/job-1/interactive-session/output",
      "/projects/project-1/runs/run-1/agents/job-1/interactive-session/ended",
      "/projects/project-1/runs/run-1/agents/job-1/interactive-session",
      "/projects/project-1/runs/run-1/agents/job-1/interactive-session/continue",
    ]);
    expect(calls[0]?.body).toMatchObject({
      mode: "interactive",
      actor: { id: "renderer-human", type: "human", trusted: true },
    });
    expect(calls[1]?.body).toMatchObject({
      desktopSessionId: "terminal-1",
      pid: 1234,
      actor: { id: "renderer-human", trusted: true },
    });
    expect(calls[2]?.body).toMatchObject({ content: "继续" });
    expect(calls[3]?.body).toMatchObject({ events: [{ data: "需要确认\r\n" }] });
    expect(calls[4]?.body).toMatchObject({ status: "COMPLETED", summary: "完成", error: null });
    expect(calls[6]?.body).toMatchObject({ actor: { id: "renderer-human", trusted: true } });
  });

  it("restores a saved Run by reading its current Runtime state", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        const responses: Record<string, unknown> = {
          "/health": { status: "ok" },
          "/projects/project-1/runs/run-1/projection": projection("run-1", "4", "REVIEWING"),
          "/projects/project-1/runs/run-1/timeline": [{ id: "event-1", type: "GATE_PASSED", createdAt: "2026-07-28T00:00:00Z" }],
          "/projects/project-1/runs/run-1/artifacts": [{ id: "artifact-1", type: "plan", uri: "file:///plan.md", contentHash: "sha256:test" }],
          "/projects/project-1/runs/run-1/approvals": [{ id: "approval-1", status: "approved" }],
          "/projects/project-1/runs/run-1/gates": [{ id: "gate-1", status: "passed", evidence: ["file:///plan.md"] }],
          "/projects/project-1/runs/run-1/agents": [],
        };
        return jsonResponse(responses[url.pathname]);
      }),
    );

    const state = await restoreWorkbenchState({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectId: "project-1",
      projectPath: "G:\\Project\\demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-1",
    });

    expect(state.workspaceStatus).toBe("ready");
    expect(state.projection).toBeNull();
    expect(state.timeline).toEqual([]);
    expect(calls).toEqual(["/health"]);
  });

  it("executes interactive runtime actions without local process access", async () => {
    const calls: Array<{ path: string; body?: unknown; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: url.pathname + url.search, body, method: init?.method ?? "GET" });

      if (url.pathname === "/projects/import") {
        return jsonResponse({
          projectId: "project-demo",
          workflowVersionId: "workflow-version-demo",
          workflowName: "Demo Workflow",
        });
      }
      if (url.pathname === "/runs") {
        return jsonResponse(projection("run-demo", "1", "CREATED"));
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/transition") {
        return jsonResponse(projection("run-demo", "2", "IN_PROGRESS"));
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/artifacts") {
        return jsonResponse(projection("run-demo", "3", "REVIEWING"));
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/approvals/plan/decide") {
        return jsonResponse(projection("run-demo", "4", "REVIEWING"));
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/gates") {
        return jsonResponse(projection("run-demo", "5", "IN_PROGRESS"));
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/agents" && init?.method === "GET") {
        return jsonResponse([
          {
            id: "job-1",
            runId: "run-demo",
            nodeId: "plan",
            provider: "fake",
            status: "COMPLETED",
            command: ["fake-cli"],
            cwd: "G:\\Project\\demo",
            summary: "完成",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:00Z",
          },
        ]);
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/agents/job-1/output") {
        return jsonResponse([
          {
            id: "out-1",
            jobId: "job-1",
            sequence: 1,
            kind: "message",
            payload: { text: "Agent 日志" },
            createdAt: "2026-07-28T00:00:00Z",
          },
        ]);
      }
      if (url.pathname === "/projects/project-demo/runs/run-demo/agents/job-1/cancel") {
        return jsonResponse({ id: "job-1", status: "CANCELLED" });
      }

      return jsonResponse({ id: "job-1", status: "COMPLETED" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createRuntimeClient("http://127.0.0.1:8765");
    const imported = await client.importProject("G:\\Project\\demo", "2026-07-28T00:00:00Z");
    const created = await client.createRun(
      imported.workflowVersionId!,
      "中文 Run",
      "2026-07-28T00:00:00Z",
      undefined,
      imported.projectId!,
    );
    await client.startNode(imported.projectId!, created.runId, "plan", created.revision, "2026-07-28T00:00:00Z");
    await client.submitArtifact(
      imported.projectId!,
      created.runId,
      "plan",
      "G:\\Project\\demo\\plan.md",
      "plan",
      "2",
      "2026-07-28T00:00:00Z",
    );
    await client.decideApproval(
      imported.projectId!,
      created.runId,
      "plan",
      "approved",
      "中文审批",
      "3",
      "2026-07-28T00:00:00Z",
    );
    await client.submitGate(
      imported.projectId!,
      created.runId,
      "plan",
      "plan-ready",
      "waived",
      [],
      "测试环境临时豁免",
      "4",
      "2026-07-28T00:00:00Z",
    );
    const job = await client.startAgentJob(
      imported.projectId!,
      created.runId,
      "plan",
      "fake",
      "请实现剩余内容",
      "2026-07-28T00:00:00Z",
    );
    await client.listAgentJobs(imported.projectId!, created.runId);
    await client.listAgentOutput(imported.projectId!, created.runId, job.id, 0);
    await client.cancelAgentJob(imported.projectId!, created.runId, job.id);
    await client.rebuildProjection(imported.projectId!, created.runId, "2026-07-28T00:00:00Z");
    await client.getEvidencePackage(imported.projectId!, created.runId);
    await client.getRunReport(imported.projectId!, created.runId);
    await client.registerTerminalSession(
      imported.projectId!,
      created.runId,
      "plan",
      "shell",
      "G:\\Project\\demo",
      1234,
      "2026-07-28T00:00:00Z",
    );
    await client.stopTerminalSession(imported.projectId!, created.runId, "terminal-1", "2026-07-28T00:00:01Z");
    await client.exportTerminalEvidence(imported.projectId!, created.runId, "terminal-1", "2026-07-28T00:00:02Z");
    await client.retryGate(imported.projectId!, created.runId, "plan", "5", "2026-07-28T00:00:03Z");
    await client.listKnowledgeDocuments();
    await client.replayKnowledgeDocument("document-1");

    expect(calls.map((call) => call.path)).toEqual([
      "/projects/import",
      "/runs",
      "/projects/project-demo/runs/run-demo/transition",
      "/projects/project-demo/runs/run-demo/artifacts",
      "/projects/project-demo/runs/run-demo/approvals/plan/decide",
      "/projects/project-demo/runs/run-demo/gates",
      "/projects/project-demo/runs/run-demo/agents",
      "/projects/project-demo/runs/run-demo/agents",
      "/projects/project-demo/runs/run-demo/agents/job-1/output?afterSequence=0",
      "/projects/project-demo/runs/run-demo/agents/job-1/cancel",
      "/projects/project-demo/runs/run-demo/rebuild-projection",
      "/projects/project-demo/runs/run-demo/evidence-package",
      "/projects/project-demo/runs/run-demo/report",
      "/projects/project-demo/runs/run-demo/terminals",
      "/projects/project-demo/runs/run-demo/terminals/terminal-1/stop",
      "/projects/project-demo/runs/run-demo/terminals/terminal-1/evidence",
      "/projects/project-demo/runs/run-demo/transition",
      "/knowledge/documents",
      "/knowledge/documents/document-1/replay",
    ]);
    expect(calls[6].body).toMatchObject({
      provider: "fake",
      prompt: "请实现剩余内容",
      allowedTools: [],
    });
    expect(calls[1].body).toMatchObject({
      projectId: "project-demo",
      workflowVersionId: "workflow-version-demo",
    });
    expect(calls[5].body).toMatchObject({
      status: "waived",
      evidence: [],
      waiverReason: "测试环境临时豁免",
    });
    expect(calls[13].body).toEqual({
      nodeId: "plan",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
      now: "2026-07-28T00:00:00Z",
    });
    expect(calls[14].body).toEqual({ now: "2026-07-28T00:00:01Z" });
    expect(calls[15].body).toMatchObject({
      actor: { id: "renderer-human", type: "human", trusted: true },
      now: "2026-07-28T00:00:02Z",
    });
    expect(calls[16].body).toMatchObject({
      eventType: "NODE_RETRIED",
      nodeId: "plan",
      actor: { id: "renderer-verifier", type: "verifier", trusted: true },
      expectedRevision: "5",
    });
    expect(fetchMock).toHaveBeenCalled();
  });

});

function scopedCreateRunResponse() {
  const workflowSnapshot = {
    id: "workflow-1",
    name: "Release workflow",
    version: "1.0.0",
    sourceAdapter: "test",
    nodes: [],
    edges: [],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
  };
  return {
    run: {
      id: "run-1",
      projectId: "project/alpha",
      workflowVersionId: "workflow-version-1",
      workflowSnapshot,
      title: "Release candidate",
      context: { taskGoal: "Ship safely", parameters: { tier: "staging" } },
      executionWorkspace: "G:/Work/release",
      workspaceMode: "write",
      status: "CREATED",
      createdAt: "2026-08-06T00:00:00Z",
      updatedAt: "2026-08-06T00:00:00Z",
    },
    projection: projection("run-1", "1", "CREATED"),
    workspace: {
      id: "lease-1",
      projectId: "project/alpha",
      runId: "run-1",
      workspacePath: "G:/Work/release",
      mode: "write",
      status: "active",
      acquiredAt: "2026-08-06T00:00:00Z",
      lastVerifiedAt: "2026-08-06T00:00:00Z",
      releasedAt: null,
      releaseReason: null,
    },
  };
}

function scopedRunOverview() {
  const created = scopedCreateRunResponse();
  return {
    ...created,
    workflow: created.run.workflowSnapshot,
    activity: {
      activeAgentCount: 1,
      activeDeploymentCount: 0,
      lastEventAt: "2026-08-06T00:00:00Z",
    },
  };
}

function projection(runId: string, revision: string, status: "CREATED" | "IN_PROGRESS" | "REVIEWING") {
  return {
    runId,
    status,
    currentNodeIds: ["plan"],
    nodeStates: { plan: "AWAITING_APPROVAL" },
    allowedActions: [],
    blockingReasons: [{ code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "plan" }],
    revision,
    updatedAt: "2026-07-28T00:00:00Z",
  };
}

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}
