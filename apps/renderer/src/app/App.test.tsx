import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/terminal/TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, output, writable, onInput, onInterrupt }: {
    ariaLabel: string;
    output: Array<{ sequence: number; data: string }>;
    writable?: boolean;
    onInput?: (data: string) => void | Promise<void>;
    onInterrupt?: () => void;
  }) => (
    <section aria-label={ariaLabel} className="terminal-viewport" data-writable={String(Boolean(writable))}>
      {output.map((event) => (
        <pre key={event.sequence}>{event.data}</pre>
      ))}
      <button type="button" onClick={() => onInput?.("继续\r")}>在 Agent 终端回复</button>
      <button type="button" onClick={onInterrupt}>中断 Agent 终端</button>
    </section>
  ),
}));

import { App } from "./App";
import { routes } from "./routes";
import { saveWorkspaceSession } from "./workspaceSession";

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
  window.location.hash = "#/runs";
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

  it("renders one matching module for every declared route", () => {
    const headings = [
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

  it("restores the saved Run from Runtime when the application starts", async () => {
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-demo",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/runs/run-demo/projection") return jsonResponse(projection("run-demo", "3", "REVIEWING"));
        if (url.pathname === "/runs/run-demo/timeline") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/artifacts") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/approvals") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/gates") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/agents") return jsonResponse([]);
        if (url.pathname === "/agents/providers") {
          return jsonResponse([{
            id: "codex",
            executable: "codex.cmd",
            available: true,
            path: "C:\\Tools\\codex.cmd",
            version: "1.0.0",
            message: "已检测到 Codex CLI。",
          }]);
        }
        return jsonResponse([]);
      }),
    );

    render(<App />);

    expect((await screen.findAllByText("REVIEWING")).length).toBeGreaterThan(0);
    expect((await screen.findByLabelText("CLI Provider 状态")).textContent).toContain(
      "已检测到 Codex CLI。",
    );
  });

  it("keeps the Runtime connected when restoring a stale saved Run fails", async () => {
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

  it("cleans orphan terminal sessions from Recovery and refreshes the diagnostic result", async () => {
    window.location.hash = "#/recovery";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
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
        if (url.pathname === "/runs/run-demo/recovery-diagnostics") {
          return jsonResponse({
            runId: "run-demo",
            eventCount: 7,
            projectionStatus: "REVIEWING",
            orphanAgentJobIds: [],
            orphanTerminalSessionIds: cleaned ? [] : ["terminal-orphan"],
            rebuildAvailable: true,
          });
        }
        if (url.pathname === "/runs/run-demo/recovery/cleanup-orphan-terminals") {
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
    expect(calls).toContain("/runs/run-demo/recovery/cleanup-orphan-terminals");
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
    expect(screen.getByLabelText("合成实时输出：产物归档规范").textContent).toContain(
      "正在汇总产物归档证据。",
    );
  });

  it("switches between persisted Runs by reloading the selected Runtime projection", async () => {
    window.location.hash = "#/runs";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-2",
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/workflow-versions/workflow-version-demo/runs") {
          return jsonResponse([
            {
              id: "run-2",
              title: "第二个并发 Run",
              status: "IN_PROGRESS",
              createdAt: "2026-07-28T00:01:00Z",
              updatedAt: "2026-07-28T00:01:00Z",
            },
            {
              id: "run-1",
              title: "第一个并发 Run",
              status: "CREATED",
              createdAt: "2026-07-28T00:00:00Z",
              updatedAt: "2026-07-28T00:00:00Z",
            },
          ]);
        }
        if (url.pathname === "/runs/run-2/projection") return jsonResponse(projection("run-2", "1", "IN_PROGRESS"));
        if (url.pathname === "/runs/run-1/projection") return jsonResponse(projection("run-1", "1", "CREATED"));
        if (url.pathname.endsWith("/timeline")) return jsonResponse([]);
        if (url.pathname.endsWith("/artifacts")) return jsonResponse([]);
        if (url.pathname.endsWith("/approvals")) return jsonResponse([]);
        if (url.pathname.endsWith("/gates")) return jsonResponse([]);
        if (url.pathname.endsWith("/agents")) return jsonResponse([]);
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    fireEvent.change(await screen.findByLabelText("切换 Run"), { target: { value: "run-1" } });

    expect(await screen.findByText("已切换到 Run：run-1")).toBeInTheDocument();
    expect(calls).toContain("/runs/run-1/projection");
  });

  it("clears the previous Run's Agent terminal while an empty Run is loading", async () => {
    window.location.hash = "#/runs";
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-with-agent",
    });
    let resolveEmptyRunProjection!: (response: Promise<Response>) => void;
    const emptyRunProjection = new Promise<Promise<Response>>((resolve) => {
      resolveEmptyRunProjection = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/workflow-versions/workflow-version-demo/runs") {
          return jsonResponse([
            { id: "run-with-agent", title: "有 Agent 的 Run", status: "IN_PROGRESS", createdAt: "2026-07-29T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" },
            { id: "run-empty", title: "空 Run", status: "CREATED", createdAt: "2026-07-29T00:01:00Z", updatedAt: "2026-07-29T00:01:00Z" },
          ]);
        }
        if (url.pathname === "/runs/run-with-agent/projection") return jsonResponse(projection("run-with-agent", "1", "IN_PROGRESS"));
        if (url.pathname === "/runs/run-empty/projection") return emptyRunProjection;
        if (url.pathname.endsWith("/timeline")) return jsonResponse([]);
        if (url.pathname.endsWith("/artifacts")) return jsonResponse([]);
        if (url.pathname.endsWith("/approvals")) return jsonResponse([]);
        if (url.pathname.endsWith("/gates")) return jsonResponse([]);
        if (url.pathname === "/runs/run-with-agent/agents") {
          return jsonResponse([{
            id: "agent-old",
            runId: "run-with-agent",
            nodeId: "plan",
            provider: "codex",
            mode: "interactive",
            status: "RUNNING",
            command: ["codex.cmd"],
            cwd: "G:\\Project\\demo",
            summary: null,
            createdAt: "2026-07-29T00:00:00Z",
            updatedAt: "2026-07-29T00:00:00Z",
          }]);
        }
        if (url.pathname === "/runs/run-empty/agents") return jsonResponse([]);
        if (url.pathname === "/runs/run-with-agent/agents/agent-old/output") {
          return jsonResponse([{ id: "out-old", jobId: "agent-old", sequence: 1, kind: "terminal_raw", payload: { text: "旧 Run 的 Agent 输出" }, createdAt: "2026-07-29T00:00:00Z" }]);
        }
        if (url.pathname === "/agents/providers") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    render(<App />);

    expect(await screen.findByText("旧 Run 的 Agent 输出")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("切换 Run"), { target: { value: "run-empty" } });

    expect(screen.getByLabelText("Agent 交互终端").textContent).not.toContain("旧 Run 的 Agent 输出");
    resolveEmptyRunProjection(jsonResponse(projection("run-empty", "1", "CREATED")));
    expect(await screen.findByText("已切换到 Run：run-empty")).toBeInTheDocument();
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
      runId: "run-demo",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/runs/run-demo/projection") return jsonResponse(projection("run-demo", "1", "CREATED"));
        if (url.pathname === "/runs/run-demo/timeline") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/artifacts") {
          return jsonResponse([
            { id: "artifact-1", type: "plan", uri: "file:///plan.md", contentHash: "sha256:plan" },
            { id: "artifact-2", type: "report", uri: "file:///report.md", contentHash: "sha256:report" },
          ]);
        }
        if (url.pathname === "/runs/run-demo/artifacts/artifact-1/preview") {
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
        if (url.pathname === "/runs/run-demo/artifacts/artifact-2/preview") {
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
        if (url.pathname === "/runs/run-demo/evidence-package") {
          return jsonResponse({ schemaVersion: 1, runId: "run-demo", projection: projection("run-demo", "1", "CREATED"), timeline: [], artifacts: [], approvals: [], gates: [] });
        }
        if (url.pathname === "/runs/run-demo/report") {
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
    window.location.hash = "#/artifacts";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    fireEvent.change(await screen.findByLabelText("基准产物"), { target: { value: "artifact-1" } });
    fireEvent.change(screen.getByLabelText("对比产物"), { target: { value: "artifact-2" } });
    fireEvent.click(screen.getByRole("button", { name: "比较产物" }));

    expect((await screen.findByLabelText("产物差异内容")).textContent).toContain("- 旧步骤");
    expect(calls).toContain("/runs/run-demo/artifacts/artifact-1/preview");
    expect(calls).toContain("/runs/run-demo/artifacts/artifact-2/preview");

    fireEvent.click(screen.getByRole("button", { name: "下载证据包" }));
    fireEvent.click(screen.getByRole("button", { name: "下载运行报告" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toContain("/runs/run-demo/evidence-package");
    expect(calls).toContain("/runs/run-demo/report");
    expect(anchorClick).toHaveBeenCalledTimes(2);
    anchorClick.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
  });

  it("lets operators drive the Runtime API from Chinese controls", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    let agentStarted = false;
    let projectionRevision = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path: url.pathname + url.search, body });

        if (url.pathname === "/health") {
          return jsonResponse({ status: "ok" });
        }
        if (url.pathname === "/agents/providers") {
          return jsonResponse([{
            id: "codex",
            executable: "codex.cmd",
            available: true,
            path: "C:\\Tools\\codex.cmd",
            version: "1.0.0",
            message: "已检测到 Codex CLI。",
          }]);
        }
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
          projectionRevision = "2";
          return jsonResponse(projection("run-demo", "2", "IN_PROGRESS"));
        }
        if (url.pathname === "/runs/run-demo/nodes/plan/artifact-requirements") {
          return jsonResponse({
            runId: "run-demo",
            nodeId: "plan",
            requirements: [{
              id: "artifact-plan",
              name: "实施计划",
              type: "plan",
              required: true,
              relativePath: "docs/plan.md",
              artifacts: [],
            }],
          });
        }
        if (url.pathname === "/runs/run-demo/artifacts" && init?.method === "POST") {
          projectionRevision = "3";
          return jsonResponse(projection("run-demo", "3", "REVIEWING"));
        }
        if (url.pathname === "/runs/run-demo/approvals/plan/decide") {
          projectionRevision = "4";
          return jsonResponse(projection("run-demo", "4", "REVIEWING"));
        }
        if (url.pathname === "/runs/run-demo/gates" && init?.method === "POST") {
          projectionRevision = "5";
          return jsonResponse(projection("run-demo", "5", "IN_PROGRESS"));
        }
        if (url.pathname === "/runs/run-demo/nodes/plan/complete") {
          projectionRevision = "6";
          return jsonResponse(projection("run-demo", "6", "IN_PROGRESS"));
        }
        if (url.pathname === "/runs/run-demo/timeline") {
          return jsonResponse([{ id: "event-1", type: "GATE_PASSED", nodeId: "plan", createdAt: "2026-07-28T00:00:00Z" }]);
        }
        if (url.pathname === "/runs/run-demo/projection") {
          return jsonResponse(
            projection(
              "run-demo",
              projectionRevision,
              projectionRevision === "1" ? "CREATED" : projectionRevision === "2" ? "IN_PROGRESS" : "REVIEWING",
            ),
          );
        }
        if (url.pathname === "/runs/run-demo/artifacts" && init?.method === "GET") {
          return jsonResponse([{ id: "artifact-1", type: "plan", uri: "file:///plan.md", contentHash: "sha256:test" }]);
        }
        if (url.pathname === "/runs/run-demo/approvals") {
          return jsonResponse([{ id: "approval-1", status: "approved", comment: "中文审批" }]);
        }
        if (url.pathname === "/runs/run-demo/gates" && init?.method === "GET") {
          return jsonResponse([{ id: "gate-1", status: "passed", evidence: ["file:///plan.md"] }]);
        }
        if (url.pathname === "/runs/run-demo/agents" && init?.method === "GET") {
          return jsonResponse(
            agentStarted
              ? [{
                  id: "job-1",
                  runId: "run-demo",
                  nodeId: "plan",
                  provider: "fake",
                  status: "RUNNING",
                  command: ["fake-cli"],
                  cwd: "G:\\Project\\demo",
                  summary: null,
                  createdAt: "2026-07-28T00:00:00Z",
                  updatedAt: "2026-07-28T00:00:00Z",
                }]
              : [],
          );
        }
        if (url.pathname === "/runs/run-demo/agents") {
          agentStarted = true;
          return jsonResponse({
            id: "job-1",
            runId: "run-demo",
            nodeId: "plan",
            provider: "fake",
            status: "RUNNING",
            command: ["fake-cli"],
            cwd: "G:\\Project\\demo",
            summary: "Agent 完成",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:00Z",
          });
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/output") {
          return jsonResponse([{ id: "out-1", jobId: "job-1", sequence: 1, kind: "message", payload: { text: "Agent 日志" }, createdAt: "2026-07-28T00:00:00Z" }]);
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/cancel") {
          return jsonResponse({ id: "job-1", status: "CANCELLED" });
        }

        return jsonResponse([]);
      }),
    );

    render(<App />);

    window.location.hash = "#/settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.change(await screen.findByLabelText("Runtime API 地址"), {
      target: { value: "http://127.0.0.1:8765" },
    });
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));

    window.location.hash = "#/projects";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.change(await screen.findByLabelText("项目路径"), {
      target: { value: "G:\\Project\\demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入项目" }));
    expect(await screen.findByText("Demo Workflow")).toBeInTheDocument();

    window.location.hash = "#/runs";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.change(await screen.findByLabelText("Run 名称"), {
      target: { value: "中文交互 Run" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 Run" }));
    expect(await screen.findByText("Run 已创建：run-demo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启动节点" }));
    expect(await screen.findByText("节点已启动：plan")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Artifact 路径"), {
      target: { value: "G:\\Project\\demo\\plan.md" },
    });
    fireEvent.change(await screen.findByLabelText("Artifact 类型"), {
      target: { value: "plan" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "提交 Artifact" }));
    expect(await screen.findByText("Artifact 已提交：plan")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "人工批准" }));
    expect(await screen.findByText("审批已通过：plan")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "通过 Gate" }));
    expect(await screen.findByText("GATE_PASSED：plan")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "完成当前节点" }));
    expect(await screen.findByText("节点已完成：plan")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Agent 提示词"), {
      target: { value: "请用中文开发剩余内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
    expect(await screen.findByText("Agent 日志")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消 Agent：job-1" }));
    expect(await screen.findByText("Agent 已取消：job-1")).toBeInTheDocument();

    expect(calls.map((call) => call.path)).toContain("/runs/run-demo/agents/job-1/cancel");
  });

  it("持续刷新运行中 Agent 的状态与新增日志", async () => {
    vi.useFakeTimers();
    let outputReadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/runs/run-demo/projection") return jsonResponse(projection("run-demo", "1", "IN_PROGRESS"));
        if (url.pathname === "/runs/run-demo/timeline") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/artifacts") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/approvals") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/gates") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/agents") {
          return jsonResponse([{
            id: "job-1",
            runId: "run-demo",
            nodeId: "plan",
            provider: "codex",
            status: outputReadCount === 0 ? "RUNNING" : "COMPLETED",
            command: ["codex.cmd", "exec"],
            cwd: "G:\\Project\\demo",
            summary: outputReadCount === 0 ? null : "已完成",
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:00:01Z",
          }]);
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/output") {
          outputReadCount += 1;
          return jsonResponse(
            outputReadCount === 1
              ? [{ id: "out-1", jobId: "job-1", sequence: 1, kind: "message", payload: { text: "第一条日志" }, createdAt: "2026-07-28T00:00:00Z" }]
              : [{ id: "out-2", jobId: "job-1", sequence: 2, kind: "final", payload: { text: "第二条日志" }, createdAt: "2026-07-28T00:00:01Z" }],
          );
        }
        return jsonResponse([]);
      }),
    );
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-demo",
    });

    render(<App />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("第一条日志")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByText("第二条日志")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent 任务").textContent).toContain("COMPLETED");
  });

  it("在桌面环境用交互式 PTY 启动 Agent，并从 Agent 终端直接回复", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    let agentStarted = false;
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create: vi.fn(async () => ({
          id: "terminal-1",
          kind: "codex",
          cwd: "G:\\Project\\demo",
          pid: 4321,
          columns: 100,
          rows: 30,
        })),
        read: vi.fn(async () => [{ sequence: 1, data: "Agent 需要回复\r\n" }]),
        writeInput: vi.fn(async () => undefined),
        interrupt: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path: url.pathname + url.search, body });
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        if (url.pathname === "/runs/run-demo/projection") return jsonResponse(projection("run-demo", "1", "IN_PROGRESS"));
        if (url.pathname === "/runs/run-demo/timeline") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/artifacts") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/approvals") return jsonResponse([]);
        if (url.pathname === "/runs/run-demo/gates") return jsonResponse([]);
        if (url.pathname === "/agents/providers") {
          return jsonResponse([{ id: "codex", executable: "codex.cmd", available: true, path: "C:\\Tools\\codex.cmd", version: "1.0.0", message: "已检测到 Codex CLI。" }]);
        }
        if (url.pathname === "/runs/run-demo/agents" && init?.method === "GET") {
          return jsonResponse(
            agentStarted
              ? [{
                  id: "job-1",
                  runId: "run-demo",
                  nodeId: "plan",
                  provider: "codex",
                  mode: "interactive",
                  status: "RUNNING",
                  command: ["codex.cmd"],
                  cwd: "G:\\Project\\demo",
                  pid: 4321,
                  sessionId: "agent-session-1",
                  summary: null,
                  error: null,
                  createdAt: "2026-07-29T00:00:00Z",
                  updatedAt: "2026-07-29T00:00:00Z",
                }]
              : [],
          );
        }
        if (url.pathname === "/runs/run-demo/agents") {
          agentStarted = true;
          return jsonResponse({
            id: "job-1",
            runId: "run-demo",
            nodeId: "plan",
            provider: "codex",
            mode: "interactive",
            status: "RUNNING",
            command: ["codex.cmd"],
            cwd: "G:\\Project\\demo",
            sessionId: "agent-session-1",
            summary: null,
            error: null,
            createdAt: "2026-07-29T00:00:00Z",
            updatedAt: "2026-07-29T00:00:00Z",
          });
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/interactive-session/start") {
          return jsonResponse({ id: "agent-session-1", status: "RUNNING" });
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/interactive-session/output") {
          return jsonResponse([{ id: "out-1", jobId: "job-1", sequence: 1, kind: "terminal_raw", payload: { text: "Agent 需要回复\r\n" }, createdAt: "2026-07-29T00:00:01Z" }]);
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/interactive-session/input") {
          return jsonResponse({ id: "input-1", content: body?.content });
        }
        if (url.pathname === "/runs/run-demo/agents/job-1/output") return jsonResponse([]);
        return jsonResponse([]);
      }),
    );
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      workflowVersionId: "workflow-version-demo",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-demo",
    });

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Agent 提示词"), { target: { value: "请继续实现剩余内容" } });
    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
    expect(await screen.findByText("交互式 Agent 已启动：job-1")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Agent 交互终端").textContent).toContain("Agent 需要回复"));
    fireEvent.click(screen.getByRole("button", { name: "在 Agent 终端回复" }));

    const terminal = (window as unknown as {
      workflowTerminal: { create: ReturnType<typeof vi.fn>; writeInput: ReturnType<typeof vi.fn> };
    }).workflowTerminal;
    expect(terminal.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "codex",
      initialPrompt: "请继续实现剩余内容",
    }));
    expect(terminal.writeInput).toHaveBeenCalledWith("terminal-1", "继续\r");
    expect(calls).toContainEqual(expect.objectContaining({
      path: "/runs/run-demo/agents",
      body: expect.objectContaining({ mode: "interactive" }),
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      path: "/runs/run-demo/agents/job-1/interactive-session/start",
      body: expect.objectContaining({ desktopSessionId: "terminal-1", pid: 4321 }),
    }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.path === "/runs/run-demo/agents/job-1/interactive-session/input" &&
            isRecord(call.body) &&
            call.body.content === "继续",
        ),
      ).toBe(true),
    );
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

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
