import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeClient, loadWorkbenchState, restoreWorkbenchState } from "./runtimeClient";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { workflowRuntime?: unknown }).workflowRuntime;
});

describe("runtimeClient", () => {
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
    expect(request).toHaveBeenCalledWith("/health", undefined);
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
      "run-demo",
      "2026-07-28T00:00:00Z",
    );

    expect(result).toEqual({
      runId: "run-demo",
      cleanedSessionIds: ["terminal-orphan"],
    });
    expect(calls).toEqual([
      {
        path: "/runs/run-demo/recovery/cleanup-orphan-terminals",
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
    const sessions = await client.listTerminalSessions("run-demo");
    const output = await client.listTerminalOutput("run-demo", "terminal-history");

    expect(sessions[0]?.status).toBe("stopped");
    expect(output[0]?.data).toContain("历史输出");
    expect(calls).toEqual([
      "/runs/run-demo/terminals",
      "/runs/run-demo/terminals/terminal-history/output?afterSequence=0",
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
    await client.startDeployment("run-1", "deploy", "7", "2026-07-28T00:00:00Z");
    await client.listDeployments("run-1");
    await client.listDeploymentOutput("run-1", "deployment-1", 3);
    await client.cancelDeployment("run-1", "deployment-1", "2026-07-28T00:00:01Z");

    expect(calls.map((call) => call.path)).toEqual([
      "/runs/run-1/deployments",
      "/runs/run-1/deployments",
      "/runs/run-1/deployments/deployment-1/output?afterSequence=3",
      "/runs/run-1/deployments/deployment-1/cancel",
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
    await client.startAgentJob("run-1", "plan", "codex", "继续开发", "2026-07-29T00:00:00Z", "interactive");
    await client.startInteractiveAgentSession("run-1", "job-1", "terminal-1", 1234, "2026-07-29T00:00:01Z");
    await client.recordInteractiveAgentInput("run-1", "job-1", "继续", "2026-07-29T00:00:02Z");
    await client.appendInteractiveAgentOutput("run-1", "job-1", [{ data: "需要确认\r\n" }], "2026-07-29T00:00:03Z");
    await client.finishInteractiveAgentSession("run-1", "job-1", "COMPLETED", "完成", null, "2026-07-29T00:00:04Z");
    await client.getInteractiveAgentSession("run-1", "job-1");
    await client.continueInteractiveAgent("run-1", "job-1", "2026-07-29T00:00:05Z");

    expect(calls.map((call) => call.path)).toEqual([
      "/runs/run-1/agents",
      "/runs/run-1/agents/job-1/interactive-session/start",
      "/runs/run-1/agents/job-1/interactive-session/input",
      "/runs/run-1/agents/job-1/interactive-session/output",
      "/runs/run-1/agents/job-1/interactive-session/ended",
      "/runs/run-1/agents/job-1/interactive-session",
      "/runs/run-1/agents/job-1/interactive-session/continue",
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
          "/runs/run-1/projection": projection("run-1", "4", "REVIEWING"),
          "/runs/run-1/timeline": [{ id: "event-1", type: "GATE_PASSED", createdAt: "2026-07-28T00:00:00Z" }],
          "/runs/run-1/artifacts": [{ id: "artifact-1", type: "plan", uri: "file:///plan.md", contentHash: "sha256:test" }],
          "/runs/run-1/approvals": [{ id: "approval-1", status: "approved" }],
          "/runs/run-1/gates": [{ id: "gate-1", status: "passed", evidence: ["file:///plan.md"] }],
          "/runs/run-1/agents": [],
        };
        return jsonResponse(responses[url.pathname]);
      }),
    );

    const state = await restoreWorkbenchState({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-1",
    });

    expect(state.workspaceStatus).toBe("ready");
    expect(state.projection?.runId).toBe("run-1");
    expect(state.timeline[0]?.type).toBe("GATE_PASSED");
    expect(calls).toEqual([
      "/health",
      "/runs/run-1/projection",
      "/runs/run-1/timeline",
      "/runs/run-1/artifacts",
      "/runs/run-1/approvals",
      "/runs/run-1/gates",
      "/runs/run-1/agents",
    ]);
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
      if (url.pathname === "/runs/run-demo/transition") {
        return jsonResponse(projection("run-demo", "2", "IN_PROGRESS"));
      }
      if (url.pathname === "/runs/run-demo/artifacts") {
        return jsonResponse(projection("run-demo", "3", "REVIEWING"));
      }
      if (url.pathname === "/runs/run-demo/approvals/plan/decide") {
        return jsonResponse(projection("run-demo", "4", "REVIEWING"));
      }
      if (url.pathname === "/runs/run-demo/gates") {
        return jsonResponse(projection("run-demo", "5", "IN_PROGRESS"));
      }
      if (url.pathname === "/runs/run-demo/agents" && init?.method === "GET") {
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
      if (url.pathname === "/runs/run-demo/agents/job-1/output") {
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
      if (url.pathname === "/runs/run-demo/agents/job-1/cancel") {
        return jsonResponse({ id: "job-1", status: "CANCELLED" });
      }

      return jsonResponse({ id: "job-1", status: "COMPLETED" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createRuntimeClient("http://127.0.0.1:8765");
    const imported = await client.importProject("G:\\Project\\demo", "2026-07-28T00:00:00Z");
    const created = await client.createRun(
      imported.workflowVersionId,
      "中文 Run",
      "2026-07-28T00:00:00Z",
    );
    await client.startNode(created.runId, "plan", created.revision, "2026-07-28T00:00:00Z");
    await client.submitArtifact(
      created.runId,
      "plan",
      "G:\\Project\\demo\\plan.md",
      "plan",
      "2",
      "2026-07-28T00:00:00Z",
    );
    await client.decideApproval(
      created.runId,
      "plan",
      "approved",
      "中文审批",
      "3",
      "2026-07-28T00:00:00Z",
    );
    await client.submitGate(
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
      created.runId,
      "plan",
      "fake",
      "请实现剩余内容",
      "2026-07-28T00:00:00Z",
    );
    await client.listAgentJobs(created.runId);
    await client.listAgentOutput(created.runId, job.id, 0);
    await client.cancelAgentJob(created.runId, job.id);
    await client.rebuildProjection(created.runId, "2026-07-28T00:00:00Z");
    await client.getEvidencePackage(created.runId);
    await client.getRunReport(created.runId);
    await client.registerTerminalSession(
      created.runId,
      "plan",
      "shell",
      "G:\\Project\\demo",
      1234,
      "2026-07-28T00:00:00Z",
    );
    await client.stopTerminalSession(created.runId, "terminal-1", "2026-07-28T00:00:01Z");
    await client.exportTerminalEvidence(created.runId, "terminal-1", "2026-07-28T00:00:02Z");
    await client.retryGate(created.runId, "plan", "5", "2026-07-28T00:00:03Z");
    await client.listKnowledgeDocuments();
    await client.replayKnowledgeDocument("document-1");

    expect(calls.map((call) => call.path)).toEqual([
      "/projects/import",
      "/runs",
      "/runs/run-demo/transition",
      "/runs/run-demo/artifacts",
      "/runs/run-demo/approvals/plan/decide",
      "/runs/run-demo/gates",
      "/runs/run-demo/agents",
      "/runs/run-demo/agents",
      "/runs/run-demo/agents/job-1/output?afterSequence=0",
      "/runs/run-demo/agents/job-1/cancel",
      "/runs/run-demo/rebuild-projection",
      "/runs/run-demo/evidence-package",
      "/runs/run-demo/report",
      "/runs/run-demo/terminals",
      "/runs/run-demo/terminals/terminal-1/stop",
      "/runs/run-demo/terminals/terminal-1/evidence",
      "/runs/run-demo/transition",
      "/knowledge/documents",
      "/knowledge/documents/document-1/replay",
    ]);
    expect(calls[6].body).toMatchObject({
      provider: "fake",
      prompt: "请实现剩余内容",
      allowedTools: [],
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
