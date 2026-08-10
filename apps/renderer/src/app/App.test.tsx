import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/terminal/TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, output, writable, onInput, onInterrupt, onResize }: {
    ariaLabel: string;
    output: Array<{ sequence: number; data: string }>;
    writable?: boolean;
    onInput?: (data: string) => void | Promise<void>;
    onInterrupt?: () => void;
    onResize?: (columns: number, rows: number) => void;
  }) => (
    <section aria-label={ariaLabel} className="terminal-viewport" data-writable={String(Boolean(writable))}>
      {output.map((event) => (
        <pre key={event.sequence}>{event.data}</pre>
      ))}
      <button type="button" onClick={() => onInput?.("继续\r")}>在 Agent 终端回复</button>
      <button type="button" onClick={onInterrupt}>中断 Agent 终端</button>
      <button type="button" onClick={() => onResize?.(120, 40)}>调整 Agent 尺寸</button>
    </section>
  ),
}));

import { App } from "./App";
import { routes } from "./routes";
import { loadWorkspaceSession, saveWorkspaceSession } from "./workspaceSession";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { workflowRuntime?: unknown }).workflowRuntime;
  delete (window as { workflowTerminal?: unknown }).workflowTerminal;
  delete (window as { workflowGit?: unknown }).workflowGit;
  window.location.hash = "";
  window.localStorage.clear();
});

beforeEach(() => {
  window.location.hash = "#/runs/run-demo";
});

const navLabels = [
  "项目",
  "运行",
  "工作流",
  "终端",
  "门禁",
  "产物",
  "审批",
  "知识库",
  "审计",
  "恢复",
  "设置",
];

describe("App", () => {
  it("loads only project-scoped summaries on the Run list route", async () => {
    window.location.hash = "#/runs";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "saved-run",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") {
        return jsonResponse({
          projectId: "project-1",
          workflowId: "workflow-1",
          workflowVersionId: "workflow-version-1",
          actor: { id: "renderer-human" },
          boundAt: "2026-08-06T00:00:00Z",
          workflowBindingStatus: "bound",
        });
      }
      if (url.pathname === "/projects/project-1/runs") {
        return jsonResponse({ items: [runSummary()], nextCursor: null });
      }
      return jsonResponse([]);
    }));

    render(<App />);

    expect(await screen.findByText("Project scoped Run")).toBeInTheDocument();
    expect(calls).toContain("/projects/project-1/runs?limit=20");
    const detailCalls = calls.filter((path) =>
      path.startsWith("/runs/") || /^\/projects\/project-1\/runs\/[^?]/.test(path));
    expect(detailCalls).toEqual([]);
    expect(calls.some((path) => path.includes("/workflow-versions/workflow-version-1/runs"))).toBe(false);
  });

  it("creates a project-scoped Run and navigates to its stable detail route", async () => {
    window.location.hash = "#/runs";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: null,
    });
    (window as typeof window & { workflowGit?: unknown }).workflowGit = {
      status: vi.fn().mockResolvedValue({
        rootPath: "G:\\Project\\demo",
        branch: "main",
        detachedHead: false,
        dirty: false,
        changes: [],
      }),
      listWorktrees: vi.fn().mockResolvedValue([
        { path: "G:\\Project\\demo", branch: "main", head: "abc", bare: false },
      ]),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      mergeBack: vi.fn(),
      push: vi.fn(),
      previewKnowledgeDocument: vi.fn(),
      publishKnowledgeDocument: vi.fn(),
    };
    let createRequest: { method?: string; headers?: HeadersInit; body?: BodyInit | null } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") {
        return jsonResponse({
          projectId: "project-1",
          workflowId: "workflow-1",
          workflowVersionId: "workflow-version-1",
          actor: { id: "renderer-human" },
          boundAt: "2026-08-06T00:00:00Z",
          workflowBindingStatus: "bound",
        });
      }
      if (url.pathname === "/projects/project-1/runs" && init?.method === "POST") {
        createRequest = init;
        return jsonResponse({ run: { id: "run created" }, projection: {}, workspace: {} });
      }
      if (url.pathname === "/projects/project-1/runs") return jsonResponse({ items: [], nextCursor: null });
      if (url.pathname === "/projects/project-1/runs/run%20created/overview") return jsonResponse(runOverview("run created"));
      return jsonResponse([]);
    }));

    render(<App />);
    fireEvent.click((await screen.findAllByRole("button", { name: "新建 Run" }))[0]);
    fireEvent.change(await screen.findByLabelText("Run 名称"), { target: { value: "Scoped creation" } });
    const createButton = screen.getByRole("button", { name: "创建 Run" });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);

    await waitFor(() => expect(window.location.hash).toBe("#/runs/run%20created"));
    expect(await screen.findByRole("heading", { name: "Scoped run created" })).toBeInTheDocument();
    expect(createRequest?.method).toBe("POST");
    expect(new Headers(createRequest?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      workflowVersionId: "workflow-version-1",
      title: "Scoped creation",
      executionWorkspace: { path: "G:\\Project\\demo", mode: "write" },
    });
    expect(loadWorkspaceSession().runId).toBe("run created");
  });

  it("loads only the project-scoped overview for the encoded detail route Run", async () => {
    window.location.hash = "#/runs/run%2Fone";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "saved-run",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/projects/project-1/runs/run%2Fone/overview") return jsonResponse(runOverview("run/one"));
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      return jsonResponse([]);
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Scoped run/one" })).toBeInTheDocument();
    expect(calls).toContain("/projects/project-1/runs/run%2Fone/overview");
    expect(calls.some((path) => path.startsWith("/runs/"))).toBe(false);
    expect(calls.some((path) => path.includes("/workflow-versions/") && path.endsWith("/runs"))).toBe(false);
  });

  it("posts detail actions through the project-scoped route with the exact Runtime action", async () => {
    window.location.hash = "#/runs/run-one";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "saved-run",
    });
    let actionRequest: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/projects/project-1/runs/run-one/overview") return jsonResponse(runOverview("run-one"));
      if (url.pathname === "/projects/project-1/runs/run-one/actions") {
        actionRequest = init;
        return jsonResponse({ projection: { ...projection("run-one", "2", "IN_PROGRESS") }, emittedEvents: [] });
      }
      return jsonResponse([]);
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "启动当前节点" }));

    await waitFor(() => expect(actionRequest).toBeDefined());
    expect(actionRequest?.method).toBe("POST");
    expect(JSON.parse(String(actionRequest?.body))).toEqual({
      actionId: "start:plan",
      expectedRevision: "1",
      actor: { id: "renderer-human", type: "human", source: "renderer", trusted: true },
    });
  });

  it("runs an interactive Agent inside Run and targets one desktop PTY", async () => {
    window.location.hash = "#/runs/run-one";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "saved-run",
    });
    const scopedOverview = runOverview("run-one");
    scopedOverview.run.status = "IN_PROGRESS";
    scopedOverview.workflow.nodes[0]!.kind = "agent";
    scopedOverview.projection = {
      ...projection("run-one", "2", "IN_PROGRESS"),
      allowedActions: [
        { id: "complete:plan", label: "Complete plan", eventType: "NODE_COMPLETED", nodeId: "plan", risk: "low" },
      ],
    };
    const terminalBridge = {
      create: vi.fn(async () => ({
        id: "desktop-agent-1",
        kind: "codex" as const,
        cwd: "G:\\Project\\demo",
        pid: 4321,
        columns: 100,
        rows: 30,
      })),
      read: vi.fn(async () => []),
      resize: vi.fn(async (_sessionId: string, columns: number, rows: number) => ({ columns, rows })),
      onOutput: vi.fn(() => () => undefined),
      writeInput: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: terminalBridge,
    });
    let agentRequest: RequestInit | undefined;
    let agentListCalls = 0;
    const job = {
      id: "agent-job-1",
      runId: "run-one",
      nodeId: "plan",
      provider: "codex",
      status: "QUEUED",
      mode: "interactive",
      command: ["codex"],
      cwd: "G:\\Project\\demo",
      createdAt: "2026-08-06T00:00:00Z",
      updatedAt: "2026-08-06T00:00:00Z",
    };
    const secondJob = { ...job, id: "agent-job-2", status: "COMPLETED", mode: "automatic" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") {
        return jsonResponse([{ id: "codex", executable: "codex", available: true, path: "C:\\bin\\codex.exe", version: "1.0", message: "available" }]);
      }
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/projects/project-1/runs/run-one/overview") return jsonResponse(scopedOverview);
      if (url.pathname === "/projects/project-1/runs/run-one/agents" && init?.method === "POST") {
        agentRequest = init;
        return jsonResponse({ ...job, job, effectivePrompt: "继续开发", contextArtifacts: [], expectedArtifacts: [] });
      }
      if (url.pathname === "/projects/project-1/runs/run-one/agents") {
        agentListCalls += 1;
        return jsonResponse(agentRequest ? [{ ...job, status: "RUNNING" }, secondJob] : []);
      }
      if (url.pathname === "/projects/project-1/runs/run-one/agents/agent-job-1/interactive-session/start") {
        return jsonResponse({
          id: "runtime-session-1",
          runId: "run-one",
          jobId: "agent-job-1",
          provider: "codex",
          status: "RUNNING",
          desktopSessionId: "desktop-agent-1",
          pid: 4321,
          cwd: "G:\\Project\\demo",
          maxOutputBytes: 1_000_000,
          createdAt: "2026-08-06T00:00:00Z",
          updatedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (url.pathname === "/projects/project-1/runs/run-one/agents/agent-job-1/interactive-session/input") {
        return jsonResponse({ id: "input-1", sessionId: "runtime-session-1", sequence: 1, kind: "input", content: "继续", createdAt: "2026-08-06T00:00:00Z" });
      }
      if (url.pathname === "/projects/project-1/runs/run-one/agents/agent-job-1/cancel") {
        return jsonResponse({ ...job, status: "CANCELLED" });
      }
      if (url.pathname === "/projects/project-1/runs/run-one/agents/agent-job-1/output") return jsonResponse([]);
      return jsonResponse([]);
    }));

    render(<App />);
    await waitFor(() => expect(agentListCalls).toBeGreaterThan(0));
    fireEvent.change(await screen.findByLabelText("Agent 提示词"), { target: { value: "继续开发" } });
    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));

    await waitFor(() => expect(agentRequest).toBeDefined());
    expect(agentRequest?.method).toBe("POST");
    expect(JSON.parse(String(agentRequest?.body))).toMatchObject({
      nodeId: "plan",
      provider: "codex",
      prompt: "继续开发",
      mode: "interactive",
      allowedTools: [],
      cwd: "G:\\Project\\demo",
    });
    const viewport = await screen.findByLabelText("Agent 执行器 agent-job-1");
    expect(viewport).toHaveAttribute("data-writable", "true");
    expect(window.location.hash).toBe("#/runs/run-one");

    fireEvent.click(screen.getByRole("link", { name: "全屏执行器" }));
    await waitFor(() => expect(window.location.hash).toBe("#/runs/run-one/agents/agent-job-1"));
    const fullScreenViewport = await screen.findByLabelText("Agent 执行器 agent-job-1");
    fireEvent.click(within(fullScreenViewport).getByRole("button", { name: "在 Agent 终端回复" }));
    fireEvent.click(within(fullScreenViewport).getByRole("button", { name: "中断 Agent 终端" }));
    fireEvent.click(within(fullScreenViewport).getByRole("button", { name: "调整 Agent 尺寸" }));
    fireEvent.click(screen.getByRole("button", { name: "停止 Agent" }));

    await waitFor(() => expect(terminalBridge.writeInput).toHaveBeenCalledWith("desktop-agent-1", "继续\r"));
    expect(terminalBridge.interrupt).toHaveBeenCalledWith("desktop-agent-1");
    expect(terminalBridge.resize).toHaveBeenCalledWith("desktop-agent-1", 120, 40);
    expect(terminalBridge.stop).toHaveBeenCalledWith("desktop-agent-1");
    fireEvent.click(screen.getByRole("tab", { name: /agent-job-2.*codex.*COMPLETED/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/runs/run-one/agents/agent-job-2"));
  });

  it("posts Gate detail actions with the canonical verifier actor", async () => {
    window.location.hash = "#/runs/run-one";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "saved-run",
    });
    const scopedOverview = runOverview("run-one");
    scopedOverview.projection.allowedActions = [
      { id: "gate-pass:plan", label: "Pass gate", eventType: "GATE_PASSED", nodeId: "plan", risk: "low" },
    ];
    let actionRequest: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/projects/project-1/runs/run-one/overview") return jsonResponse(scopedOverview);
      if (url.pathname === "/projects/project-1/runs/run-one/actions") {
        actionRequest = init;
        return jsonResponse({ projection: scopedOverview.projection, emittedEvents: [] });
      }
      return jsonResponse([]);
    }));

    render(<App />);
    fireEvent.change(await screen.findByLabelText("证据 URI"), { target: { value: "artifact://quality/report" } });
    fireEvent.click(screen.getByRole("button", { name: "通过检查关卡" }));

    await waitFor(() => expect(actionRequest).toBeDefined());
    expect(JSON.parse(String(actionRequest?.body))).toEqual({
      actionId: "gate-pass:plan",
      expectedRevision: "1",
      actor: { id: "renderer-verifier", type: "verifier", source: "runtime", trusted: true },
      payload: { evidenceUri: "artifact://quality/report" },
    });
  });

  it("shows scoped not-found state without restoring a saved Run projection", async () => {
    window.location.hash = "#/runs/missing-run";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "saved-run",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/projects/project-1/runs/missing-run/overview") {
        return new Response(JSON.stringify({ code: "RUN_NOT_FOUND_IN_PROJECT", message: "Missing scoped Run" }), { status: 404 });
      }
      return jsonResponse([]);
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "此项目中不存在该 Run" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回 Run 列表" })).toBeInTheDocument();
    expect(calls).not.toContain("/runs/saved-run/projection");
  });

  it("reloads the scoped Run list after leaving and returning to the route", async () => {
    window.location.hash = "#/runs";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: null,
    });
    let listCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/projects/project-1/runs") {
        listCount += 1;
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      return jsonResponse([]);
    }));

    render(<App />);
    await waitFor(() => expect(listCount).toBe(1));
    window.location.hash = "#/projects";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await screen.findByRole("heading", { name: "项目工作区" });
    window.location.hash = "#/runs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    // Project overview loads one recent page and one active-count page before returning.
    await waitFor(() => expect(listCount).toBe(4));
  });

  it("retains scoped Run rows and refresh time after a refresh failure", async () => {
    window.location.hash = "#/runs";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: null,
    });
    let listCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/projects/project-1/runs") {
        listCount += 1;
        if (listCount > 1) {
          return new Response(JSON.stringify({
            code: "RUN_REARCHITECTURE_MAINTENANCE",
            message: "Maintenance",
            correlationId: "correlation-refresh",
          }), { status: 503 });
        }
        return jsonResponse({ items: [runSummary()], nextCursor: null });
      }
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      return jsonResponse([]);
    }));

    render(<App />);
    expect(await screen.findByText("Project scoped Run")).toBeInTheDocument();
    expect(screen.getByText(/上次刷新/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新 Run 列表" }));

    expect(await screen.findByText("correlation-refresh")).toBeInTheDocument();
    expect(screen.getByText("Project scoped Run")).toBeInTheDocument();
    expect(screen.getByText(/上次刷新/)).toBeInTheDocument();
  });

  it("shows only the selected hash route and responds to browser history", async () => {
    window.location.hash = "#/projects";
    render(<App />);

    expect(await screen.findByRole("heading", { name: "项目工作区" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "运行管理" })).not.toBeInTheDocument();

    window.location.hash = "#/workflow";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(await screen.findByRole("heading", { name: "工作流视图" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "项目工作区" })).not.toBeInTheDocument();
  });

  it("binds a terminal to the selected Run and displays the exported Evidence URI", async () => {
    window.location.hash = "#/terminal";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      projectName: "Demo project",
      workflowName: "Demo workflow",
      runId: "run-1",
    });
    const evidenceUri = "file:///G:/Project/demo/.workflow-platform/evidence/terminal.log";
    const requests: Array<{ path: string; method: string }> = [];
    let readCount = 0;
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create: vi.fn(async () => ({
          id: "desktop-terminal-1",
          kind: "shell",
          cwd: "G:\\Project\\demo",
          pid: 4321,
          columns: 100,
          rows: 30,
        })),
        bindRuntimeSession: vi.fn(async () => undefined),
        exportOutput: vi.fn(async () => ({ path: "unused.log", firstSequence: 1, lastSequence: 1 })),
        submitShellLine: vi.fn(async () => ({ status: "executed", commandSummary: "" })),
        writeInput: vi.fn(async () => undefined),
        approveCommand: vi.fn(async () => ({ status: "executed", commandSummary: "" })),
        rejectCommand: vi.fn(async () => ({ status: "blocked", reason: "cancelled" })),
        read: vi.fn(async () => readCount++ === 0 ? [{ sequence: 1, data: "verified\r\n" }] : []),
        resize: vi.fn(async () => ({
          id: "desktop-terminal-1",
          kind: "shell",
          cwd: "G:\\Project\\demo",
          pid: 4321,
          columns: 100,
          rows: 30,
        })),
        interrupt: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/workflow-versions/workflow-version-1/runs") {
        return jsonResponse([
          { ...runSummary(), id: "run-1", title: "主流程" },
          { ...runSummary(), id: "run-2", title: "发布流程" },
        ]);
      }
      if (url.pathname === "/projects/project-1/runs") {
        return jsonResponse({
          items: [
            { ...runSummary(), id: "run-1", title: "主流程" },
            { ...runSummary(), id: "run-2", title: "发布流程" },
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === "/projects/project-1/runs/run-2/overview") {
        const overview = runOverview("run-2");
        overview.workflow.nodes = [
          { id: "plan", name: "计划", kind: "task" },
          { id: "verify", name: "验证", kind: "task" },
        ];
        return jsonResponse(overview);
      }
      if (url.pathname === "/projects/project-1/runs/run-2/terminals" && method === "POST") {
        return jsonResponse({ id: "runtime-terminal-2" });
      }
      if (url.pathname === "/projects/project-1/runs/run-2/terminals") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/runs/run-2/terminals/runtime-terminal-2/output") {
        return jsonResponse({ accepted: true });
      }
      if (url.pathname === "/projects/project-1/runs/run-2/terminals/runtime-terminal-2/evidence") {
        return jsonResponse({
          id: "terminal-evidence-1",
          runId: "run-2",
          type: "evidence",
          uri: evidenceUri,
          contentHash: "sha256:evidence",
        });
      }
      if (url.pathname === "/projects/project-1/runs/run-2/artifacts") return jsonResponse([]);
      return jsonResponse([]);
    }));

    render(<App />);
    fireEvent.change(await screen.findByLabelText("关联 Run"), { target: { value: "run-2" } });
    await screen.findByRole("option", { name: "验证" });
    fireEvent.change(screen.getByLabelText("绑定节点"), { target: { value: "verify" } });
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await screen.findByText("verified");
    fireEvent.click(screen.getByRole("button", { name: "导出终端证据" }));

    expect(await screen.findByRole("status")).toHaveTextContent(evidenceUri);
    expect(requests).toContainEqual({ path: "/projects/project-1/runs/run-2/terminals", method: "POST" });
    expect(requests).toContainEqual({
      path: "/projects/project-1/runs/run-2/terminals/runtime-terminal-2/evidence",
      method: "POST",
    });
  });

  it("loads every project Run page and reveals ended Runs from older workflow versions", async () => {
    window.location.hash = "#/terminal";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-1",
      workflowVersionId: "workflow-version-2",
      projectName: "Demo project",
      workflowName: "Current workflow",
      runId: "run-current",
    });
    const requests: string[] = [];
    const postRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      if (init?.method === "POST") postRequests.push(url.pathname);
      if (url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/agents/providers") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/workflow-binding") return jsonResponse(null);
      if (url.pathname === "/workflow-versions/workflow-version-2/runs") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/runs" && url.searchParams.get("cursor") === "older") {
        return jsonResponse({
          items: [{
            ...runSummary(),
            id: "run-old",
            title: "旧 Run",
            status: "DONE",
            workflowVersionId: "workflow-version-1",
            workflowName: "旧工作流",
            workflowVersion: "1",
            createdAt: "2026-08-01T00:00:00Z",
          }],
          nextCursor: null,
        });
      }
      if (url.pathname === "/projects/project-1/runs") {
        return jsonResponse({
          items: [{
            ...runSummary(),
            id: "run-current",
            title: "当前 Run",
            status: "IN_PROGRESS",
            workflowVersionId: "workflow-version-2",
            workflowName: "Current workflow",
            workflowVersion: "2",
          }],
          nextCursor: "older",
        });
      }
      if (url.pathname === "/projects/project-1/runs/run-current/terminals") return jsonResponse([]);
      if (url.pathname === "/projects/project-1/runs/run-old/overview") return jsonResponse(runOverview("run-old"));
      if (url.pathname === "/projects/project-1/runs/run-old/terminals") {
        return jsonResponse([{
          id: "history-old",
          runId: "run-old",
          nodeId: "plan",
          kind: "shell",
          status: "stopped",
          cwd: "G:\\Project\\old",
          pid: null,
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:01:00Z",
        }]);
      }
      if (url.pathname === "/projects/project-1/runs/run-old/terminals/history-old/output") {
        return jsonResponse([{
          sequence: 1,
          stream: "stdout",
          data: "old Run output",
          createdAt: "2026-08-01T00:00:00Z",
        }]);
      }
      return jsonResponse([]);
    }));

    render(<App />);

    expect(await screen.findByRole("option", { name: /当前 Run.*IN_PROGRESS.*Current workflow 2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("显示已结束 Run"));
    expect(await screen.findByRole("option", { name: /旧 Run.*DONE.*旧工作流 1/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("关联 Run"), { target: { value: "run-old" } });
    const oldSession = await screen.findByRole("option", { name: /plan.*shell.*stopped/ });
    fireEvent.change(screen.getByLabelText("历史终端会话"), { target: { value: oldSession.getAttribute("value") } });
    fireEvent.click(screen.getByRole("button", { name: "查看历史输出" }));
    expect(await screen.findByText("old Run output")).toBeInTheDocument();
    expect(requests).toContain("/projects/project-1/runs?limit=100");
    expect(requests).toContain("/projects/project-1/runs?cursor=older&limit=100");
    expect(requests).toContain("/projects/project-1/runs/run-old/terminals");
    expect(requests).toContain("/projects/project-1/runs/run-old/terminals/history-old/output?afterSequence=0");
    expect(postRequests).not.toContain("/projects/project-1/runs/run-old/terminals");
  });

  it("renders one matching module for every declared route", () => {
    const headings = [
      "角色库",
      "项目工作区",
      "运行管理",
      "工作流视图",
      "终端",
      "门禁",
      "产物",
      "审批中心",
      "知识库",
      "审计记录",
      "恢复",
      "运行时设置",
    ];

    routes.forEach((route, index) => {
      window.location.hash = route.hash;
      const { unmount } = render(<App />);
      expect(screen.getByRole("heading", { name: headings[index] })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: route.label })).toHaveAttribute("aria-current", "page");
      unmount();
    });
  });

  it("returns unknown hashes to projects", () => {
    window.location.hash = "#/unknown";
    render(<App />);

    expect(window.location.hash).toBe("#/projects");
    expect(screen.getByRole("heading", { name: "项目工作区" })).toBeInTheDocument();
  });

  it("loads the project workflow binding when restoring directly into runs", async () => {
    window.location.hash = "#/runs/run-restored";
    const calls: string[] = [];
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      projectId: "project-restored",
      workflowVersionId: "workflow-version-cached",
      projectName: "demo",
      workflowName: "缓存工作流",
      runId: "run-restored",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/projects/project-restored/workflow-binding") {
          return jsonResponse({
            projectId: "project-restored",
            workflowId: "workflow-restored",
            workflowVersionId: "workflow-version-bound",
            actor: { id: "renderer-human" },
            boundAt: "2026-08-04T00:00:00Z",
            workflowBindingStatus: "bound",
          });
        }
        if (url.pathname === "/projects/project-restored/runs/run-restored/overview") {
          return jsonResponse({ ...runOverview("run-restored"), run: { ...runOverview("run-restored").run, projectId: "project-restored" } });
        }
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Scoped run-restored" });
    await waitFor(() => expect(calls).toContain("/projects/project-restored/workflow-binding"));
    expect(calls).not.toContain("/workflow-versions/workflow-version-bound");
  });

  it("blocks Run creation after an imported project is confirmed unbound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/projects/import") {
          return jsonResponse({ projectId: "project-unbound", workflowVersionId: null, workflowBindingStatus: "unbound" });
        }
        if (url.pathname === "/projects/project-unbound/workflow-binding") return jsonResponse(null);
        if (url.pathname === "/projects/project-unbound/runs") return jsonResponse({ items: [], nextCursor: null });
        if (url.pathname === "/workflows" || url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    window.location.hash = "#/projects";
    render(<App />);
    fireEvent.change(await screen.findByLabelText("项目路径"), { target: { value: "G:\\Project\\unbound" } });
    fireEvent.click(screen.getByRole("button", { name: "导入项目" }));
    await screen.findByRole("heading", { name: "选择工作流" });

    window.location.hash = "#/runs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.click((await screen.findAllByRole("button", { name: "新建 Run" }))[0]);
    expect(await screen.findByText("当前项目尚未绑定工作流")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往工作流库" })).toBeInTheDocument();
  });

  it("isolates a new workflow draft from the previously selected workflow version", async () => {
    window.location.hash = "#/workflow/new";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-old",
      projectName: "demo",
      workflowName: "旧工作流",
      runId: null,
    });
    window.sessionStorage.setItem("workflow-draft:workflow-version-old", JSON.stringify({ name: "旧草稿" }));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    expect(await screen.findByText("未命名工作流")).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText("工作流定义 JSON") as HTMLTextAreaElement).value).toContain("未命名工作流"));
    expect(screen.queryByText("旧草稿")).not.toBeInTheDocument();
    expect(calls).not.toContain("/workflow-versions/workflow-version-old");
  });

  it("blocks an archived workflow asset route before any old version can be loaded or saved", async () => {
    window.location.hash = "#/workflow/archived-workflow";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-old",
      projectName: "demo",
      workflowName: "旧工作流",
      runId: null,
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        if (url.pathname === "/workflows") {
          return jsonResponse([{
            workflowId: "archived-workflow",
            name: "归档流程",
            isBuiltin: false,
            archivedAt: "2026-08-04T10:00:00Z",
            updatedAt: "2026-08-04T10:00:00Z",
            workflowVersionId: "workflow-version-archived",
            currentVersion: "2",
            nodeCount: 2,
            boundProjectCount: 0,
          }]);
        }
        return jsonResponse([]);
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "工作流不可用" })).toBeInTheDocument();
    expect(screen.getByText("该工作流已归档，不能继续编辑或保存新版本。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存新版本" })).not.toBeInTheDocument();
    expect(calls).not.toContain("/workflow-versions/workflow-version-old");
  });

  it("shows an explicit error for an unknown workflow asset route", async () => {
    window.location.hash = "#/workflow/missing-workflow";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/agents/providers" || url.pathname === "/workflows") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "工作流不可用" })).toBeInTheDocument();
    expect(screen.getByText("找不到该工作流，可能已被删除或没有访问权限。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存新版本" })).not.toBeInTheDocument();
  });

  it("opens an editor when its version already matches the cached workflow version", async () => {
    window.location.hash = "#/workflow";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "delivery-version-1",
      projectName: "demo",
      workflowName: "产品交付",
      runId: null,
    });
    const workflow = {
      workflowId: "product-delivery",
      name: "产品交付",
      isBuiltin: false,
      archivedAt: null,
      updatedAt: "2026-08-04T10:00:00Z",
      workflowVersionId: "delivery-version-1",
      currentVersion: "1",
      nodeCount: 1,
      boundProjectCount: 0,
    };
    const definition = {
      id: "delivery-definition",
      name: "产品交付",
      version: "1",
      sourceAdapter: "manual",
      nodes: [{ id: "plan", name: "计划", kind: "task" }],
      edges: [],
      roles: [],
      gates: [],
      policies: {},
      metadata: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        if (url.pathname === "/workflows") return jsonResponse([workflow]);
        if (url.pathname === "/workflow-versions/delivery-version-1") return jsonResponse(definition);
        if (url.pathname === "/workflow-versions/delivery-version-1/compile") return jsonResponse({ diagnostics: [], graphSpec: { nodes: [], edges: [] } });
        if (url.pathname === "/workflow-versions/delivery-version-1/history") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑 产品交付" }));

    await waitFor(() => {
      expect((screen.getByLabelText("工作流定义 JSON") as HTMLTextAreaElement).value).toContain("产品交付");
    });
    expect(screen.queryByText("正在验证工作流...")).not.toBeInTheDocument();
  });

  it("opens a copied template as an editable asset and returns to the refreshed library after save", async () => {
    window.location.hash = "#/workflow";
    let copied = false;
    const template = {
      workflowId: "delivery-template",
      name: "交付模板",
      isBuiltin: true,
      archivedAt: null,
      updatedAt: "2026-08-04T10:00:00Z",
      workflowVersionId: "template-version",
      currentVersion: "1",
      nodeCount: 1,
      boundProjectCount: 0,
    };
    const copiedAsset = {
      workflowId: "my-delivery",
      name: "交付模板副本",
      isBuiltin: false,
      archivedAt: null,
      updatedAt: "2026-08-04T11:00:00Z",
      workflowVersionId: "my-delivery-version",
      currentVersion: "1",
      nodeCount: 1,
      boundProjectCount: 0,
    };
    const definition = {
      id: "my-delivery-definition",
      name: "交付模板副本",
      version: "1",
      sourceAdapter: "manual",
      nodes: [{ id: "plan", name: "计划", kind: "task" }],
      edges: [],
      roles: [],
      gates: [],
      policies: {},
      metadata: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        if (url.pathname === "/workflows") return jsonResponse(copied ? [template, copiedAsset] : [template]);
        if (url.pathname === "/workflows/delivery-template/copy") {
          copied = true;
          return jsonResponse({ workflowId: "my-delivery", workflowVersionId: "my-delivery-version", isBuiltin: false });
        }
        if (url.pathname === "/workflow-versions/my-delivery-version") return jsonResponse(definition);
        if (url.pathname === "/workflow-versions/my-delivery-version/compile") return jsonResponse({ diagnostics: [], graphSpec: { nodes: [], edges: [] } });
        if (url.pathname === "/workflow-versions/my-delivery-version/history") return jsonResponse([]);
        if (url.pathname === "/workflow-versions/my-delivery-version/save") {
          return jsonResponse({
            workflowVersionId: "my-delivery-version-2",
            definition: { ...definition, version: "2" },
            compiled: { diagnostics: [], graphSpec: { nodes: [], edges: [] } },
          });
        }
        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "基于模板新建 交付模板" }));
    expect(await screen.findByText("交付模板副本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() => expect(window.location.hash).toBe("#/workflow"));
    expect(await screen.findByRole("button", { name: "编辑 交付模板副本" })).toBeInTheDocument();
  });

  it("restores the saved Run from Runtime when the application starts", async () => {
    window.location.hash = "#/projects";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-demo",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("连接状态：已连接")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .not.toContain("/runs/run-demo/projection");
  });

  it("keeps the Runtime connected when restoring a stale saved Run fails", async () => {
    window.location.hash = "#/projects";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-missing",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-missing",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/runs/run-missing/projection") {
          return new Response(JSON.stringify({ detail: "Run not found" }), { status: 404 });
        }
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    expect(await screen.findByText("连接状态：已连接")).toBeInTheDocument();
  });

  it("renders invalid Run context without requesting Run children", async () => {
    window.location.hash = "#/artifacts?projectId=project-1";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      projectId: "project-1",
      runId: "run-demo",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/health") return jsonResponse({ status: "ok" });
      return jsonResponse([]);
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Run 链接无效" })).toBeInTheDocument();
    expect(calls.filter((path) => path.includes("/runs/"))).toEqual([]);
  });

  it("cleans orphan terminal sessions from Recovery and refreshes the diagnostic result", async () => {
    window.location.hash = "#/recovery?projectId=project-1&runId=run-demo";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      projectId: "project-1",
      runId: "run-demo",
    });
    const calls: string[] = [];
    let cleaned = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/runs/run-demo/projection") return jsonResponse(projection("run-demo", "3", "REVIEWING"));
        if (url.pathname === "/runs/run-demo/timeline") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/artifacts") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/approvals") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/gates") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/agents") return jsonResponse([]);
        if (url.pathname === "/projects/project-1/runs/run-demo/recovery-diagnostics") {
          return jsonResponse({
            runId: "run-demo",
            eventCount: 7,
            projectionStatus: "REVIEWING",
            orphanAgentJobIds: [],
            orphanTerminalSessionIds: cleaned ? [] : ["terminal-orphan"],
            rebuildAvailable: true,
          });
        }
        if (url.pathname === "/projects/project-1/runs/run-demo/recovery/cleanup-orphan-terminals") {
          cleaned = true;
          return jsonResponse({ runId: "run-demo", cleanedSessionIds: ["terminal-orphan"] });
        }
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "清理遗留终端" }));

    expect(await screen.findByText("已清理遗留终端：1 个")).toBeInTheDocument();
    expect(calls).toContain("/projects/project-1/runs/run-demo/recovery/cleanup-orphan-terminals");
    expect(screen.queryByRole("button", { name: "清理遗留终端" })).not.toBeInTheDocument();
  });

  it("loads desktop Runtime diagnostics and restarts the managed service from settings", async () => {
    window.location.hash = "#/settings";
    const calls: string[] = [];
    const restart = vi.fn(async () => ({
      mode: "managed",
      state: "ready",
      url: "http://127.0.0.1:8765",
      port: 8765,
      pid: 54321,
      lastError: null,
    }));
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: {
        status: vi.fn(async () => ({
          mode: "managed",
          state: "failed",
          url: "http://127.0.0.1:8765",
          port: 8765,
          pid: null,
          lastError: "Runtime process exited",
        })),
        logs: vi.fn(async () => [{
          level: "error",
          message: "Runtime process exited",
          createdAt: "2026-07-28T00:00:00Z",
        }]),
        restart,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/diagnostics/support-bundle") {
          return jsonResponse({
            fileName: "workflow-platform-diagnostics.json",
            mediaType: "application/json",
            content: "{\"title\":\"诊断支持包\"}",
          });
        }
        if (url.pathname === "/agents/providers") {
          return jsonResponse([
            {
              id: "codex",
              executable: "codex.cmd",
              available: true,
              path: "C:\\Tools\\codex.cmd",
              version: "1.2.3",
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
          ]);
        }
        return jsonResponse({ status: "ok" });
      }),
    );
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const anchorClick = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:diagnostics"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(anchorClick);

    render(<App />);

    expect(await screen.findByText("受管 Runtime")).toBeInTheDocument();
    expect(screen.getByText("启动失败")).toBeInTheDocument();
    expect(await screen.findByText("Codex CLI：已检测到 Codex CLI。")).toBeInTheDocument();
    expect(screen.getByText("Claude Code CLI：未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检测 CLI" }));
    expect(await screen.findByText("CLI 可用性诊断已更新。")).toBeInTheDocument();
    expect(calls.filter((path) => path === "/agents/providers").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "重启 Runtime" }));
    expect(await screen.findByText("运行正常")).toBeInTheDocument();
    expect(restart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "下载诊断支持包" }));
    expect(await screen.findByText("诊断支持包已下载。")).toBeInTheDocument();
    expect(calls).toContain("/diagnostics/support-bundle");
    expect(anchorClick).toHaveBeenCalledTimes(1);
    anchorClick.mockRestore();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });

  it("connects the project workspace when the managed desktop Runtime becomes ready", async () => {
    window.location.hash = "#/projects";
    Object.defineProperty(window, "workflowRuntime", {
      configurable: true,
      value: {
        status: vi.fn(async () => ({
          mode: "managed",
          state: "ready",
          url: "http://127.0.0.1:8879",
          port: 8879,
          pid: 54321,
          lastError: null,
        })),
        logs: vi.fn(async () => []),
        restart: vi.fn(),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.origin === "http://127.0.0.1:8879" && url.pathname === "/health") {
          return jsonResponse({ status: "ok" });
        }
        throw new Error(`Unexpected Runtime request: ${url.href}`);
      }),
    );

    render(<App />);

    expect(await screen.findByText("Runtime 已连接")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("项目路径"), { target: { value: "G:\\Project\\demo" } });
    expect(screen.getByRole("button", { name: "导入项目" })).toBeEnabled();
  });

  it("loads published knowledge and requests its Runtime replay", async () => {
    window.location.hash = "#/knowledge";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/knowledge/candidates") {
          return jsonResponse([
            {
              id: "candidate-1",
              title: "产物归档规范",
              content: "所有产物必须保留内容哈希。",
              source: "run:run-archive",
              status: "approved",
              createdAt: "2026-07-28T00:00:00Z",
            },
          ]);
        }
        if (url.pathname === "/knowledge/documents") {
          return jsonResponse([
            {
              id: "document-1",
              candidateId: "candidate-1",
              title: "产物归档规范",
              content: "所有产物必须保留内容哈希。",
              source: "run:run-archive",
              status: "published",
              publishedAt: "2026-07-28T00:00:00Z",
            },
          ]);
        }
        if (url.pathname === "/knowledge/syntheses") {
          return jsonResponse([
            {
              id: "synthesis-1",
              candidateId: "candidate-1",
              provider: "codex",
              status: "COMPLETED",
              prompt: "合成提示",
              summary: "所有产物必须保留内容哈希和回滚证据。",
              error: null,
              feedback: null,
              createdAt: "2026-07-28T00:00:00Z",
              updatedAt: "2026-07-28T00:01:00Z",
            },
          ]);
        }
        if (url.pathname === "/knowledge/syntheses/synthesis-1/output") {
          return jsonResponse([
            {
              id: "synthesis-1:output:1",
              synthesisId: "synthesis-1",
              sequence: 1,
              kind: "message",
              payload: { text: "正在汇总产物归档证据。" },
              createdAt: "2026-07-28T00:00:00Z",
            },
          ]);
        }
        if (url.pathname === "/knowledge/documents/document-1/replay") {
          return jsonResponse({
            document: {
              id: "document-1",
              candidateId: "candidate-1",
              title: "产物归档规范",
              content: "所有产物必须保留内容哈希。",
              source: "run:run-archive",
              status: "published",
              publishedAt: "2026-07-28T00:00:00Z",
            },
            candidate: {
              id: "candidate-1",
              title: "产物归档规范",
              content: "所有产物必须保留内容哈希。",
              source: "run:run-archive",
              status: "approved",
              createdAt: "2026-07-28T00:00:00Z",
              reviewComment: "内容可复用",
            },
            auditRecords: [
              {
                id: "audit-1",
                action: "knowledge.candidate.published",
                resource: "knowledge-candidate:candidate-1",
                detail: { documentId: "document-1" },
                actor: { id: "human-1", type: "human", source: "runtime", trusted: true },
                previousHash: null,
                recordHash: "hash-1",
                createdAt: "2026-07-28T00:00:00Z",
              },
            ],
          });
        }
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "回放发布记录：产物归档规范" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls).toContain("/knowledge/documents/document-1/replay");
    expect(screen.getByText("内容可复用")).toBeInTheDocument();
    expect(calls).toContain("/knowledge/syntheses/synthesis-1/output");
    fireEvent.click(screen.getByRole("button", { name: "查看 CLI 执行日志" }));
    expect(screen.getByLabelText("CLI 执行日志：产物归档规范").textContent).toContain(
      "正在汇总产物归档证据。",
    );
  });

  it("does not record a Runtime Git publication when the desktop push fails", async () => {
    window.location.hash = "#/knowledge";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-demo",
    });
    Object.defineProperty(window, "workflowGit", {
      configurable: true,
      value: {
        publishKnowledgeDocument: vi.fn(async () => {
          throw new Error("远程仓库认证失败");
        }),
      },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/knowledge/candidates") return jsonResponse([]);
        if (url.pathname === "/knowledge/documents") {
          return jsonResponse([
            {
              id: "document-1",
              candidateId: "candidate-1",
              title: "产物归档规范",
              content: "所有产物必须保留内容哈希。",
              source: "run:run-archive",
              status: "published",
              publishedAt: "2026-07-28T00:00:00Z",
              gitPublicationCount: 0,
              latestGitPublication: null,
            },
          ]);
        }
        if (url.pathname === "/knowledge/documents/document-1/export") {
          return jsonResponse({
            fileName: "document-1.md",
            mediaType: "text/markdown",
            content: "# 产物归档规范\n",
          });
        }
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "提交并推送知识：产物归档规范" }));

    expect(await screen.findByText("提交并推送知识失败：远程仓库认证失败")).toBeInTheDocument();
    expect(calls).not.toContain("/knowledge/documents/document-1/git-publications");
  });

  it("loads two Runtime-backed text previews before showing an artifact comparison", async () => {
    window.location.hash = "#/artifacts?projectId=project-1&runId=run-demo";
    const calls: string[] = [];
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:report"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      projectId: "project-1",
      runId: "run-demo",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/workflow-versions/workflow-version-demo/runs") {
          return jsonResponse([{ id: "run-demo", title: "Demo Run", status: "CREATED", createdAt: "2026-07-28T00:00:00Z" }]);
        }
        if (url.pathname === "/runs/run-demo/projection") return jsonResponse(projection("run-demo", "1", "CREATED"));
        if (url.pathname === "/runs/run-demo/timeline") return jsonResponse([]);
        if (url.pathname === "/projects/project-1/runs/run-demo/artifacts") {
          return jsonResponse([
            { id: "artifact-1", runId: "run-demo", type: "plan", uri: "file:///plan.md", contentHash: "sha256:plan" },
            { id: "artifact-2", runId: "run-demo", type: "report", uri: "file:///report.md", contentHash: "sha256:report" },
          ]);
        }
        if (url.pathname === "/projects/project-1/runs/run-demo/artifacts/artifact-1/preview") {
          return jsonResponse({
            id: "artifact-1",
            uri: "file:///plan.md",
            contentHash: "sha256:plan",
            currentHash: "sha256:plan",
            integrity: "verified",
            mediaType: "text/markdown",
            sizeBytes: 12,
            truncated: false,
            content: "计划\n旧步骤\n",
          });
        }
        if (url.pathname === "/projects/project-1/runs/run-demo/artifacts/artifact-2/preview") {
          return jsonResponse({
            id: "artifact-2",
            uri: "file:///report.md",
            contentHash: "sha256:report",
            currentHash: "sha256:report",
            integrity: "verified",
            mediaType: "text/markdown",
            sizeBytes: 12,
            truncated: false,
            content: "计划\n新步骤\n",
          });
        }
        if (url.pathname === "/projects/project-1/runs/run-demo/evidence-package") {
          return jsonResponse({ schemaVersion: 1, runId: "run-demo", projection: projection("run-demo", "1", "CREATED"), timeline: [], artifacts: [], approvals: [], gates: [] });
        }
        if (url.pathname === "/projects/project-1/runs/run-demo/report") {
          return jsonResponse({
            fileName: "run-demo-evidence-report.md",
            mediaType: "text/markdown",
            content: "# Run 证据报告：run-demo\n",
          });
        }
        if (url.pathname === "/runs/run-demo/approvals") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/gates") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/agents") return jsonResponse([]);
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    await screen.findByText("artifact-1");
    fireEvent.change(await screen.findByLabelText("基准产物"), { target: { value: "artifact-1" } });
    fireEvent.change(screen.getByLabelText("对比产物"), { target: { value: "artifact-2" } });
    const compareButton = screen.getByRole("button", { name: "比较产物" });
    await waitFor(() => expect(compareButton).toBeEnabled());
    fireEvent.click(compareButton);

    expect((await screen.findByLabelText("产物差异内容")).textContent).toContain("- 旧步骤");
    expect(calls).toContain("/projects/project-1/runs/run-demo/artifacts/artifact-1/preview");
    expect(calls).toContain("/projects/project-1/runs/run-demo/artifacts/artifact-2/preview");

    fireEvent.click(screen.getByRole("button", { name: "下载证据包" }));
    fireEvent.click(screen.getByRole("button", { name: "下载运行报告" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toContain("/projects/project-1/runs/run-demo/evidence-package");
    expect(calls).toContain("/projects/project-1/runs/run-demo/report");
    expect(anchorClick).toHaveBeenCalledTimes(2);
    anchorClick.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
  });

  it("renders the MVP workbench navigation", () => {
    render(<App />);

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    for (const label of navLabels) {
      expect(within(navigation).getByText(label)).toBeInTheDocument();
    }
  });

  it("renders a status-oriented workbench as the first screen", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "AI Workflow 工作台" })).toBeInTheDocument();
    expect(screen.getAllByText("当前 Run 状态").length).toBeGreaterThan(0);
    expect(await screen.findByText("尚未创建 Run")).toBeInTheDocument();
    expect(screen.queryByText("AI Workflow Platform")).not.toBeInTheDocument();
  });

});

function projection(runId: string, revision: string, status: "CREATED" | "IN_PROGRESS" | "REVIEWING") {
  const actionByRevision = {
    "1": {
      nodeState: "READY",
      action: { id: "start", label: "启动节点", eventType: "NODE_STARTED", nodeId: "plan", risk: "low" },
      blockingReason: { code: "WAITING_TO_START", message: "等待启动", nodeId: "plan" },
    },
    "2": {
      nodeState: "RUNNING",
      action: { id: "submit-artifact", label: "提交 Artifact", eventType: "ARTIFACT_SUBMITTED", nodeId: "plan", risk: "medium" },
      blockingReason: { code: "WAITING_FOR_ARTIFACT", message: "等待产物", nodeId: "plan" },
    },
    "3": {
      nodeState: "AWAITING_APPROVAL",
      action: { id: "approve", label: "人工批准", eventType: "HUMAN_APPROVED", nodeId: "plan", risk: "high" },
      blockingReason: { code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "plan" },
    },
    "4": {
      nodeState: "AWAITING_GATE",
      action: { id: "pass-gate", label: "通过 Gate", eventType: "GATE_PASSED", nodeId: "plan", risk: "medium" },
      blockingReason: { code: "WAITING_FOR_GATE", message: "等待 Gate", nodeId: "plan" },
    },
    "5": {
      nodeState: "RUNNING",
      action: { id: "complete", label: "完成当前节点", eventType: "NODE_COMPLETED", nodeId: "plan", risk: "low" },
      blockingReason: { code: "READY_TO_COMPLETE", message: "节点可以完成", nodeId: "plan" },
    },
    "6": {
      nodeState: "PASSED",
      action: { id: "start", label: "启动节点", eventType: "NODE_STARTED", nodeId: "plan", risk: "low" },
      blockingReason: { code: "NONE", message: "无阻塞", nodeId: "plan" },
    },
  }[revision] ?? {
    nodeState: "PASSED",
    action: { id: "start", label: "启动节点", eventType: "NODE_STARTED", nodeId: "plan", risk: "low" },
    blockingReason: { code: "NONE", message: "无阻塞", nodeId: "plan" },
  };

  return {
    runId,
    status,
    currentNodeIds: ["plan"],
    nodeStates: { plan: actionByRevision.nodeState },
    allowedActions: [actionByRevision.action],
    blockingReasons: [actionByRevision.blockingReason],
    revision,
    updatedAt: "2026-07-28T00:00:00Z",
  };
}

function runSummary() {
  return {
    id: "run-project-1",
    projectId: "project-1",
    workflowVersionId: "workflow-version-1",
    workflowName: "Demo workflow",
    workflowVersion: "1",
    title: "Project scoped Run",
    status: "CREATED",
    taskGoal: "Verify scoped loading",
    currentNodes: [],
    nextNodes: [],
    progress: { total: 1, passed: 0, running: 0, blocked: 0, pending: 1 },
    blocker: null,
    workspace: {
      path: "G:\\Project\\demo",
      label: "main",
      leaseMode: "write",
      leaseStatus: "active",
    },
    activeAgentCount: 0,
    activeDeploymentCount: 0,
    createdAt: "2026-08-06T00:00:00Z",
    updatedAt: "2026-08-06T00:00:00Z",
  };
}

function runOverview(runId: string) {
  const workflow = {
    id: "workflow-1",
    name: "Immutable scoped workflow",
    version: "1",
    sourceAdapter: "harness",
    nodes: [{ id: "plan", name: "Plan", kind: "task" }],
    edges: [],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
  };
  return {
    run: {
      id: runId,
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      workflowSnapshot: workflow,
      title: `Scoped ${runId}`,
      context: { taskGoal: "Verify scoped detail", parameters: {} },
      executionWorkspace: "G:\\Project\\demo",
      workspaceMode: "write",
      status: "CREATED",
      createdAt: "2026-08-06T00:00:00Z",
      updatedAt: "2026-08-06T00:00:00Z",
    },
    projection: {
      ...projection(runId, "1", "CREATED"),
      allowedActions: [
        { id: "start:plan", label: "Start plan", eventType: "NODE_STARTED", nodeId: "plan", risk: "low" },
      ],
    },
    workflow,
    workspace: null,
    activity: { activeAgentCount: 0, activeDeploymentCount: 0, lastEventAt: "2026-08-06T00:00:00Z" },
  };
}

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
