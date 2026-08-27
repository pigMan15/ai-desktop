import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Actor,
  ExecuteRunActionRequest,
  ExecuteRunActionResponse,
  RunOverview,
  WorkflowDefinition,
} from "@workflow-platform/contracts";
import {
  RuntimeClientError,
  type AgentJobSummary,
  type AgentOutputSummary,
} from "../../app/runtimeClient";
import { RunDetailPage } from "./RunDetailPage";

vi.mock("../terminal/TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, output, writable, onInput }: {
    ariaLabel: string;
    output: Array<{ sequence: number; data: string }>;
    writable?: boolean;
    onInput?: (data: string) => void | Promise<void>;
  }) => (
    <section aria-label={ariaLabel} data-writable={String(Boolean(writable))}>
      <pre>{output.map((event) => event.data).join("")}</pre>
      <button type="button" onClick={() => onInput?.("继续\r")}>输入 Agent</button>
    </section>
  ),
}));

vi.mock("./RunProgressMap", () => ({
  RunProgressMap: ({ onSelectNode }: { onSelectNode(nodeId: string): void }) => (
    <section aria-label="运行进度图">
      <button type="button" onClick={() => onSelectNode("verify")}>选择验证</button>
    </section>
  ),
}));

const actor: Actor = {
  id: "renderer-human",
  type: "human",
  source: "renderer",
  trusted: true,
};

const gateActor: Actor = {
  id: "renderer-verifier",
  type: "verifier",
  source: "runtime",
  trusted: true,
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("RunDetailPage", () => {
  it("organizes the Run as a progress-and-control console followed by resource tabs", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
    const consoleRegion = screen.getByRole("region", { name: "运行进度与控制" });
    const graph = within(consoleRegion).getByLabelText("运行进度图");
    const workspace = graph.closest(".run-console-workspace");
    const executor = within(consoleRegion).getByRole("region", { name: "Agent 执行器" });
    const controls = within(consoleRegion).getByRole("region", { name: "当前节点控制" });
    expect(workspace).not.toBeNull();
    expect(graph.compareDocumentPosition(executor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(workspace!.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const resources = screen.getByRole("navigation", { name: "Run 资源" });
    expect(within(resources).getByRole("tab", { name: "上下文", selected: true })).toBeInTheDocument();
    expect(within(resources).getByRole("link", { name: "产物" })).toHaveAttribute(
      "href",
      "#/artifacts?projectId=project%2Fone&runId=run%2Fone",
    );
  });

  it("shows Agent launch controls for the running Agent node", async () => {
    const startedJob = agentJob("job-new", "RUNNING");
    const onStartAgent = vi.fn().mockResolvedValue(startedJob);
    const agentWorkflow = workflowDefinition();
    agentWorkflow.roles = [{
      id: "developer",
      name: "Developer",
      provider: "codex",
      allowedTools: ["read", "edit"],
    }];
    window.location.hash = "#/runs/run%2Fone";
    const view = renderPage({
      overview: overview({ workflow: agentWorkflow }),
      agentJobs: [],
      onStartAgent,
      providerDiagnostics: [
        { id: "codex", executable: "codex", available: true, path: "C:\\bin\\codex.exe", version: "1.0", message: "available" },
        { id: "claude", executable: "claude", available: false, path: null, version: null, message: "unavailable" },
      ],
    });

    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
      const debugRegions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
  console.log("DEBUG_REGIONS", JSON.stringify(debugRegions));
const agentRegion = await screen.findByRole("region", { name: "Agent 执行" });
    const mode = within(agentRegion).getByRole("radiogroup", { name: "执行界面" });
    expect(within(mode).getByRole("radio", { name: "终端界面" })).toBeChecked();
    expect(within(mode).getByRole("radio", { name: "后台一次性" })).not.toBeChecked();
    expect(within(agentRegion).queryByRole("textbox", { name: "执行工作区" })).not.toBeInTheDocument();
    expect(within(agentRegion).getByText("G:\\project\\release")).toBeInTheDocument();
    expect(within(agentRegion).getByText("Developer")).toBeInTheDocument();
    expect(within(agentRegion).getByText("read, edit")).toBeInTheDocument();
    expect(within(agentRegion).getByText("Codex CLI 可用")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent 提示词"), { target: { value: "继续开发" } });
    const startButton = screen.getByRole("button", { name: "启动 Agent" });
    expect(startButton.querySelector(".lucide-play")).toBeInTheDocument();
    fireEvent.click(startButton);

    await waitFor(() => expect(onStartAgent).toHaveBeenCalledWith({
      nodeId: "implement",
      provider: "codex",
      prompt: "继续开发",
      mode: "interactive",
      allowedTools: ["read", "edit"],
      cwd: "G:\\project\\release",
      transport: "auto",
      conversational: false,
      modelProviderId: null,
    }));
    expect(window.location.hash).toBe("#/runs/run%2Fone");
    view.rerender(page({
      overview: overview({ workflow: agentWorkflow }),
      agentJobs: [startedJob],
      onStartAgent,
    }));
    expect(screen.getByRole("tab", { name: /job-new.*codex.*RUNNING/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("link", { name: /打开 Agent 终端/ })).not.toBeInTheDocument();
  });

  it("starts Codex chat mode through app-server so it can keep a conversation and execute commands", async () => {
    const startedJob = agentJob("job-new", "AWAITING_INPUT");
    const onStartAgent = vi.fn().mockResolvedValue(startedJob);
    const agentWorkflow = workflowDefinition();
    agentWorkflow.roles = [{
      id: "developer",
      name: "Developer",
      provider: "codex",
      allowedTools: ["read", "edit"],
    }];
    renderPage({
      overview: overview({ workflow: agentWorkflow }),
      agentJobs: [],
      onStartAgent,
      providerDiagnostics: [
        { id: "codex", executable: "codex", available: true, path: "C:\\bin\\codex.exe", version: "1.0", message: "available" },
      ],
    });

    await screen.findByRole("region", { name: "Agent 执行" });
    const agentRegion = document.querySelector<HTMLElement>(".run-agent-command");
    expect(agentRegion).not.toBeNull();
    const controls = agentRegion!;
    const chatMode = controls.querySelector<HTMLInputElement>('input[name="agent-ui-mode"][value="chat"]');
    const prompt = controls.querySelector<HTMLTextAreaElement>(".run-agent-prompt textarea");
    const startButton = controls.querySelector<HTMLButtonElement>(".run-agent-start");
    expect(chatMode).not.toBeNull();
    expect(prompt).not.toBeNull();
    expect(startButton).not.toBeNull();

    fireEvent.click(chatMode!);
    fireEvent.change(prompt!, { target: { value: "List files and run tests" } });
    fireEvent.click(startButton!);

    await waitFor(() =>
      expect(onStartAgent).toHaveBeenCalledWith(expect.objectContaining({
        provider: "codex",
        mode: "automatic",
        transport: "app-server",
        conversational: true,
        modelProviderId: null,
      })),
    );
  });

  it("switches Agent Job tabs and forwards input to the selected Job", async () => {
    const onAgentInput = vi.fn();
    const runningJob = agentJob("job-running", "RUNNING");
    const completedJob = agentJob("job-completed", "COMPLETED");
    renderPage({
      agentJobs: [runningJob, completedJob],
      agentLiveOutput: {
        "job-running": [{ sequence: 1, data: "running output" }],
      },
      agentOutput: [agentOutput("job-completed", "completed output")],
      agentSessionState: {
        "job-running": { writable: true },
      },
      onAgentInput,
    });

    expect(await screen.findByText("running output")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /job-complete.*codex.*COMPLETED/i }));
    expect(screen.getByText("completed output")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /job-running.*codex.*RUNNING/i }));
    fireEvent.click(screen.getByRole("button", { name: "输入 Agent" }));
    expect(onAgentInput).toHaveBeenCalledWith("job-running", "继续\r");
  });

  it("does not show Agent launch controls before the Agent node starts or for a non-Agent node", async () => {
    const readyOverview = overview({
      projection: {
        ...overview().projection,
        nodeStates: { implement: "READY", verify: "PENDING", review: "PENDING" },
      },
    });
    const { rerender } = renderPage({ overview: readyOverview });
    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent 执行" })).not.toBeInTheDocument();

    const taskWorkflow = workflowDefinition();
    taskWorkflow.nodes = taskWorkflow.nodes.map((node) => node.id === "implement" ? { ...node, kind: "task" } : node);
    rerender(page({ overview: overview({ workflow: taskWorkflow }) }));
    expect(screen.queryByRole("region", { name: "Agent 执行" })).not.toBeInTheDocument();
  });

  it("starts a governed deployment from a ready deploy node", async () => {
    const onStartDeployment = vi.fn().mockResolvedValue(undefined);
    const deployWorkflow = workflowDefinition();
    deployWorkflow.nodes = deployWorkflow.nodes.map((node) =>
      node.id === "implement" ? { ...node, kind: "deploy", agent: undefined } : node,
    );
    renderPage({
      overview: overview({
        workflow: deployWorkflow,
        projection: {
          ...overview().projection,
          nodeStates: { implement: "READY", verify: "PENDING", review: "PENDING" },
          allowedActions: [{
            id: "start:implement",
            label: "Start node",
            eventType: "NODE_STARTED",
            nodeId: "implement",
            risk: "low",
          }],
        },
      }),
      onStartDeployment,
    });

    fireEvent.click(await screen.findByRole("button", { name: "启动本地部署" }));

    await waitFor(() => expect(onStartDeployment).toHaveBeenCalledWith("implement", "11"));
  });

  it("keeps Agent launch read-only for an archived Run", async () => {
    renderPage({
      overview: overview({
        run: { ...overview().run, status: "ARCHIVED" },
        projection: { ...overview().projection, status: "ARCHIVED" },
      }),
      onStartAgent: vi.fn(),
    });

    expect(await screen.findByRole("button", { name: "启动 Agent" })).toBeDisabled();
    expect(screen.getByLabelText("Agent 提示词")).toBeDisabled();
  });

  it("renders the scoped overview in graph, current, next, action source order", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回 Run 列表" })).toHaveAttribute("href", "#/runs");
    const graph = screen.getByLabelText("运行进度图");
    const current = screen.getByRole("region", { name: "当前工作环节" });
    const next = screen.getByRole("region", { name: "下一工作环节" });
    const actions = screen.getByRole("region", { name: "Runtime 授权操作" });
    expect(graph.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(current.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(current).toHaveTextContent("Implement change");
    expect(current).toHaveTextContent("agent");
    expect(current).toHaveTextContent("developer");
    expect(current).toHaveTextContent("Write the requested change");
    expect(current).toHaveTextContent("source-bundle");
    expect(current).toHaveTextContent("release-notes.md");
    expect(current).toHaveTextContent("手动完成");
    expect(current).toHaveTextContent("G:\\project\\release");
    expect(current).toHaveTextContent("1 个活跃 Agent");
    expect(current).toHaveTextContent("Waiting for source bundle");
    expect(current).toHaveTextContent("Global policy hold");
    expect(next).toHaveTextContent("2 个候选后继环节");
    expect(next).toHaveTextContent("Verify release");
    expect(next).toHaveTextContent("tests pass");
    expect(next).toHaveTextContent("Manual review");

    expect(screen.getByText(/Immutable release workflow v7/)).toBeInTheDocument();
    expect(screen.getByText(/"dryRun": true/)).toBeInTheDocument();
    expect(screen.getAllByText("G:\\project\\release").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 个活跃 Agent").length).toBeGreaterThan(0);
    expect(screen.getByText("2 个活跃部署")).toBeInTheDocument();
    expect(screen.getByText(/租约 active/)).toBeInTheDocument();
    expect(screen.getByText(/最近刷新/)).toBeInTheDocument();
    for (const route of ["artifacts", "gates", "approvals", "deployment", "audit", "recovery"]) {
      expect(screen.getByRole("link", { name: secondaryLabel(route) })).toHaveAttribute(
        "href",
        `#/${route}?projectId=project%2Fone&runId=run%2Fone`,
      );
    }
    expect(await screen.findByRole("region", { name: "Agent 执行器" })).toBeInTheDocument();
  });

  it("renders only allowed actions and sends the exact action id, revision, actor, and payload", async () => {
    const executeAction = vi.fn().mockResolvedValue(actionResponse("12"));
    renderPage({
      executeAction,
      overview: overview({
        projection: {
          ...overview().projection,
          allowedActions: [
            ...overview().projection.allowedActions,
            { id: "approve-review", label: "Approve review", eventType: "HUMAN_APPROVED", nodeId: "review", risk: "medium" },
          ],
        },
      }),
    });

    expect(await screen.findByRole("button", { name: "扫描并提交所需产物" })).toBeDisabled();
    expect(screen.getAllByText("批准当前节点").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "启动当前节点" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("产物路径"), { target: { value: "docs/release.md" } });
    fireEvent.change(screen.getByLabelText("产物类型"), { target: { value: "document" } });
    expect(screen.getByRole("button", { name: "扫描并提交所需产物" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "扫描并提交所需产物" }));

    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
    expect(executeAction.mock.calls[0]?.[0]).toEqual({
      actionId: "submit-artifact",
      expectedRevision: "11",
      actor,
      payload: { artifactPath: "docs/release.md", artifactType: "document" },
    });
    expect(executeAction.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("uses the injected verifier actor for Gate actions without accepting a client Gate id", async () => {
    const executeAction = vi.fn().mockResolvedValue(actionResponse("12"));
    renderPage({
      executeAction,
      overview: overview({
        projection: {
          ...overview().projection,
          allowedActions: [
            { id: "pass-quality", label: "Pass", eventType: "GATE_PASSED", nodeId: "implement", risk: "high" },
          ],
        },
      }),
    });

    fireEvent.change(await screen.findByLabelText("证据 URI"), { target: { value: "artifact://quality/report" } });
    fireEvent.click(screen.getAllByText("通过检查关卡")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "确认执行 通过检查关卡" }));

    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
    expect(executeAction.mock.calls[0]?.[0]).toEqual({
      actionId: "pass-quality",
      expectedRevision: "11",
      actor: gateActor,
      payload: { evidenceUri: "artifact://quality/report" },
    });
    expect(executeAction.mock.calls[0]?.[0].payload).not.toHaveProperty("gateId");
  });

  it("requires explicit confirmation for medium and high risk actions", async () => {
    const executeAction = vi.fn().mockResolvedValue(actionResponse("12"));
    renderPage({
      executeAction,
      overview: overview({
        projection: {
          ...overview().projection,
          allowedActions: [
            { id: "approve", label: "Approve", eventType: "HUMAN_APPROVED", nodeId: "implement", risk: "medium" },
            { id: "archive", label: "Archive", eventType: "RUN_ARCHIVED", risk: "high" },
          ],
        },
      }),
    });

    expect((await screen.findAllByText("批准当前节点")).length).toBeGreaterThan(0);
    expect(executeAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText("批准当前节点")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "确认执行 批准当前节点" }));
    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
  });

  it("replaces the projection after an action and then refreshes the overview once", async () => {
    const refreshed = deferred<RunOverview>();
    const loadOverview = vi.fn()
      .mockResolvedValueOnce(overview())
      .mockImplementationOnce(() => refreshed.promise);
    const executeAction = vi.fn().mockResolvedValue(actionResponse("12", "PAUSED"));
    renderPage({ loadOverview, executeAction });

    fireEvent.change(await screen.findByLabelText("产物路径"), { target: { value: "docs/release.md" } });
    fireEvent.change(screen.getByLabelText("产物类型"), { target: { value: "document" } });
    fireEvent.click(screen.getByRole("button", { name: "扫描并提交所需产物" }));

    await waitFor(() => expect(screen.getByText(/已暂停/)).toHaveTextContent("修订 12"));
    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(2));
    refreshed.resolve(overview({ projection: { ...overview().projection, revision: "13", status: "PAUSED" } }));
    await waitFor(() => expect(screen.getByText(/已暂停/)).toHaveTextContent("修订 13"));
  });

  it("polls active and terminal runs at their respective intervals without overlapping", async () => {
    vi.useFakeTimers();
    const second = deferred<RunOverview>();
    const loadOverview = vi.fn()
      .mockResolvedValueOnce(overview())
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(overview({ projection: { ...overview().projection, status: "DONE" } }));
    renderPage({ loadOverview });
    await act(async () => Promise.resolve());

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(loadOverview).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(loadOverview).toHaveBeenCalledTimes(2);
    second.resolve(overview({ projection: { ...overview().projection, status: "DONE" } }));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(loadOverview).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(loadOverview).toHaveBeenCalledTimes(3);
  });

  it("does not invent a current node for a terminal Run without current nodes", async () => {
    renderPage({
      overview: overview({
        projection: {
          ...overview().projection,
          status: "DONE",
          currentNodeIds: [],
          allowedActions: [],
          blockingReasons: [],
        },
      }),
    });

    expect(await screen.findByRole("region", { name: "当前工作环节" })).toHaveTextContent("无当前环节");
    expect(screen.getByRole("region", { name: "下一工作环节" })).toHaveTextContent("无直接后续环节");
    expect(screen.getByRole("region", { name: "下一工作环节" })).toHaveTextContent("Run 已完成");
    expect(screen.queryByText("Implement change")).not.toBeInTheDocument();
  });

  it("reports missing optional node metadata without inferring a goal or completion mode", async () => {
    const workflow = workflowDefinition();
    const nodes = workflow.nodes.map((node) => node.id === "implement"
      ? { ...node, description: undefined, advance: undefined }
      : node);
    renderPage({ overview: overview({ workflow: { ...workflow, nodes } }) });

    const current = await screen.findByRole("region", { name: "当前工作环节" });
    expect(current).toHaveTextContent("未提供节点目标");
    expect(current).toHaveTextContent("未声明");
    expect(current).not.toHaveTextContent("Ship release candidate");
  });

  it("hides write actions immediately after an archived response while refreshing", async () => {
    const refreshed = deferred<RunOverview>();
    const loadOverview = vi.fn().mockResolvedValueOnce(overview()).mockImplementationOnce(() => refreshed.promise);
    const executeAction = vi.fn().mockRejectedValue(runtimeError(409, "RUN_ARCHIVED", "Run 已归档"));
    renderPage({ loadOverview, executeAction });
    fireEvent.change(await screen.findByLabelText("产物路径"), { target: { value: "docs/release.md" } });
    fireEvent.change(screen.getByLabelText("产物类型"), { target: { value: "document" } });
    fireEvent.click(screen.getByRole("button", { name: "扫描并提交所需产物" }));

    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "扫描并提交所需产物" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Runtime 授权操作" })).toHaveTextContent("0 项可用");
  });

  it("pauses hidden polling and refreshes when the page becomes visible or focused", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const loadOverview = vi.fn().mockResolvedValue(overview());
    renderPage({ loadOverview });
    await act(async () => Promise.resolve());

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(loadOverview).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(loadOverview).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(loadOverview).toHaveBeenCalledTimes(3);
  });

  it("aborts the active request on unmount and ignores a stale project response", async () => {
    const first = deferred<RunOverview>();
    const second = deferred<RunOverview>();
    const firstLoad = vi.fn((_signal: AbortSignal) => first.promise);
    const secondLoad = vi.fn((_signal: AbortSignal) => second.promise);
    const view = renderPage({ loadOverview: firstLoad });
    const firstSignal = firstLoad.mock.calls[0]?.[0];

    view.rerender(page({ projectId: "project-two", runId: "run-two", loadOverview: secondLoad }));
    expect(firstSignal?.aborted).toBe(true);
    first.resolve(overview({ run: { ...overview().run, title: "Stale Run" } }));
    second.resolve(overview({ run: { ...overview().run, title: "Current Run" } }));

    expect(await screen.findByRole("heading", { name: "Current Run" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Stale Run" })).not.toBeInTheDocument();
    const activeSignal = secondLoad.mock.calls[0]?.[0];
    view.unmount();
    expect(activeSignal?.aborted).toBe(true);
  });

  it("clears a loaded overview immediately when the project or Run identity changes", async () => {
    const next = deferred<RunOverview>();
    const view = renderPage({ loadOverview: vi.fn().mockResolvedValue(overview()) });
    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();

    view.rerender(page({
      projectId: "project-two",
      runId: "run-two",
      loadOverview: vi.fn(() => next.promise),
    }));

    expect(screen.queryByRole("heading", { name: "Release candidate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: secondaryLabel("artifacts") })).not.toBeInTheDocument();
    next.resolve(overview({ run: { ...overview().run, id: "run-two", projectId: "project-two", title: "Second Run" } }));
    expect(await screen.findByRole("heading", { name: "Second Run" })).toBeInTheDocument();
  });

  it("distinguishes concurrent actions by node and keeps their inputs isolated", async () => {
    const executeAction = vi.fn().mockResolvedValue(actionResponse("12"));
    renderPage({
      executeAction,
      overview: overview({
        projection: {
          ...overview().projection,
          allowedActions: [
            { id: "approve-implement", label: "Approve implementation", eventType: "HUMAN_APPROVED", nodeId: "implement", risk: "medium" },
            { id: "approve-review", label: "Approve review", eventType: "HUMAN_APPROVED", nodeId: "review", risk: "medium" },
          ],
        },
      }),
    });

    const implementAction = await screen.findByRole("group", { name: /Implement change/ });
    const reviewAction = screen.getByRole("group", { name: /Manual review/ });
    fireEvent.change(within(implementAction).getByRole("textbox"), { target: { value: "implementation ok" } });
    expect(within(reviewAction).getByRole("textbox")).toHaveValue("");
    fireEvent.click(implementAction.querySelector("summary")!);
    fireEvent.click(within(implementAction).getByRole("button", { name: /Approve implementation/ }));

    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
    expect(executeAction.mock.calls[0]?.[0]).toMatchObject({
      actionId: "approve-implement",
      payload: { comment: "implementation ok" },
    });
  });

  it("scans declared node artifacts without requiring manual path input", async () => {
    const refreshed = deferred<RunOverview>();
    const loadOverview = vi.fn()
      .mockResolvedValueOnce(overview())
      .mockImplementationOnce(() => refreshed.promise);
    const scanNodeArtifacts = vi.fn().mockResolvedValue({
      runId: "run/one",
      nodeId: "implement",
      registered: ["bundle"],
      unchanged: ["notes"],
      missing: [],
      invalid: [],
      projection: {
        ...actionResponse("12").projection,
        allowedActions: [{
          id: "complete-implement",
          label: "完成当前节点",
          eventType: "NODE_COMPLETED",
          nodeId: "implement",
          risk: "low",
        }],
        blockingReasons: [],
      },
    });
    const executeAction = vi.fn();
    renderPage({ loadOverview, scanNodeArtifacts, executeAction });

    const action = await screen.findByRole("button", { name: "扫描并提交所需产物" });
    expect(screen.getByLabelText("产物路径")).toHaveValue("docs/release.md");
    expect(screen.getByLabelText("产物类型")).toHaveValue("document");
    expect(action).toBeEnabled();
    fireEvent.click(action);

    await waitFor(() => expect(scanNodeArtifacts).toHaveBeenCalledWith(
      "implement",
      "11",
      expect.any(String),
      expect.any(AbortSignal),
    ));
    expect(executeAction).not.toHaveBeenCalled();
    const feedback = await screen.findByRole("status", { name: "产物检查结果" });
    expect(feedback).toHaveTextContent("已满足 2/2");
    expect(feedback).toHaveTextContent("本次提交1");
    expect(feedback).toHaveTextContent("已存在1");
    expect(feedback).toHaveTextContent("可以完成当前节点");
    expect(executeAction).not.toHaveBeenCalled();
    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(2));
    refreshed.resolve(overview({
      projection: {
        ...overview().projection,
        revision: "12",
        allowedActions: [{
          id: "complete-implement",
          label: "完成当前节点",
          eventType: "NODE_COMPLETED",
          nodeId: "implement",
          risk: "low",
        }],
        blockingReasons: [],
      },
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "完成当前节点" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "选择验证" }));
    expect(screen.queryByRole("status", { name: "产物检查结果" })).not.toBeInTheDocument();
  });

  it("shows artifact scan failures in the artifact result area", async () => {
    const scanNodeArtifacts = vi.fn().mockRejectedValue(
      runtimeError(422, "ARTIFACT_SCAN_FAILED", "Cannot read output"),
    );
    renderPage({ scanNodeArtifacts });

    fireEvent.click(await screen.findByRole("button", { name: "扫描并提交所需产物" }));

    expect(await screen.findByRole("status", { name: "产物检查结果" }))
      .toHaveTextContent("Cannot read output");
  });

  it("restores the latest artifact scan result after returning to the Run page", async () => {
    const scanNodeArtifacts = vi.fn().mockResolvedValue({
      runId: "run/one",
      nodeId: "implement",
      registered: ["bundle"],
      unchanged: ["notes"],
      missing: [],
      invalid: [],
      projection: overview().projection,
    });
    const firstPage = renderPage({ scanNodeArtifacts });

    fireEvent.click(await screen.findByRole("button", { name: "扫描并提交所需产物" }));
    expect(await screen.findByRole("status", { name: "产物检查结果" })).toHaveTextContent("已满足 2/2");

    firstPage.unmount();
    renderPage();

    expect(await screen.findByRole("status", { name: "产物检查结果" })).toHaveTextContent("已满足 2/2");
  });

  it("disables actions while a refresh request is pending", async () => {
    const refresh = deferred<RunOverview>();
    const loadOverview = vi.fn().mockResolvedValueOnce(overview()).mockImplementationOnce(() => refresh.promise);
    renderPage({ loadOverview });
    fireEvent.change(await screen.findByLabelText("产物路径"), { target: { value: "docs/release.md" } });
    fireEvent.change(screen.getByLabelText("产物类型"), { target: { value: "document" } });
    const action = screen.getByRole("button", { name: "扫描并提交所需产物" });
    expect(action).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(loadOverview).toHaveBeenCalledTimes(2);
    refresh.resolve(overview());
  });

  it("retains cached data after refresh failure and reports a revision conflict", async () => {
    const loadOverview = vi.fn()
      .mockResolvedValueOnce(overview())
      .mockRejectedValueOnce(runtimeError(503, "RUN_REARCHITECTURE_MAINTENANCE", "Runtime 暂不可用"))
      .mockResolvedValueOnce(overview({ projection: { ...overview().projection, revision: "12" } }));
    const executeAction = vi.fn().mockRejectedValue(
      runtimeError(409, "REVISION_CONFLICT", "修订冲突"),
    );
    renderPage({ loadOverview, executeAction });
    await screen.findByRole("heading", { name: "Release candidate" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("Runtime 暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Release candidate" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("产物路径"), { target: { value: "docs/release.md" } });
    fireEvent.change(screen.getByLabelText("产物类型"), { target: { value: "document" } });
    fireEvent.click(screen.getByRole("button", { name: "扫描并提交所需产物" }));
    expect(await screen.findByText("状态已更新，已刷新当前 Run。" )).toBeInTheDocument();
    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByText(/运行中/)).toHaveTextContent("修订 12"));
  });

  it("retries an uncached transient load failure while the page remains visible", async () => {
    vi.useFakeTimers();
    const loadOverview = vi.fn()
      .mockRejectedValueOnce(runtimeError(null, "NETWORK_ERROR", "offline"))
      .mockResolvedValueOnce(overview());
    renderPage({ loadOverview });

    await act(async () => Promise.resolve());
    expect(loadOverview).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(loadOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
  });

  it("keeps the Run page alive while the initial workflow snapshot is temporarily unavailable", async () => {
    const incomplete = { ...overview(), workflow: undefined } as unknown as RunOverview;
    renderPage({ overview: incomplete });

    expect(await screen.findByRole("status")).toHaveTextContent("工作流加载中");
    expect(screen.queryByLabelText("运行进度图")).not.toBeInTheDocument();
  });

  it("restores the last workflow snapshot after returning while the overview is incomplete", async () => {
    const firstPage = renderPage();
    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
    firstPage.unmount();

    const incomplete = { ...overview(), workflow: undefined } as unknown as RunOverview;
    renderPage({ overview: incomplete });

    expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
    expect(screen.getByLabelText("运行进度图")).toBeInTheDocument();
  });

  it.each([
    [404, "RUN_NOT_FOUND_IN_PROJECT", "此项目中不存在该 Run", "返回 Run 列表"],
    [503, "RUN_REARCHITECTURE_MAINTENANCE", "Run 服务维护中", "重试"],
  ] as const)("renders the uncached %s %s state", async (status, code, message, actionName) => {
    const loadOverview = vi.fn().mockRejectedValue(runtimeError(status, code, message));
    renderPage({ loadOverview });

    expect(await screen.findByRole("heading", { name: message })).toBeInTheDocument();
    expect(screen.getByRole(actionName === "返回 Run 列表" ? "link" : "button", { name: actionName })).toBeInTheDocument();
  });
});

function renderPage(options: Partial<React.ComponentProps<typeof RunDetailPage>> & { overview?: RunOverview } = {}) {
  const element = page(options);
  return { ...render(element), props: element.props };
}

function page(options: Partial<React.ComponentProps<typeof RunDetailPage>> & { overview?: RunOverview } = {}) {
  const value = options.overview ?? overview();
  return (
    <RunDetailPage
      projectId={options.projectId ?? "project/one"}
      runId={options.runId ?? "run/one"}
      projectName={options.projectName ?? "Desktop"}
      actor={options.actor ?? actor}
      gateActor={options.gateActor ?? gateActor}
      loadOverview={options.loadOverview ?? vi.fn().mockResolvedValue(value)}
      agentJobs={options.agentJobs ?? [agentJob("job ?7", "RUNNING")]}
      agentOutput={options.agentOutput ?? []}
      agentLiveOutput={options.agentLiveOutput ?? {}}
      agentSessionState={options.agentSessionState ?? {}}
      providerDiagnostics={options.providerDiagnostics}
      modelProviders={options.modelProviders}
      activeModelProviderId={options.activeModelProviderId}
      onStartAgent={options.onStartAgent}
      onStartDeployment={options.onStartDeployment}
      onAgentInput={options.onAgentInput ?? vi.fn()}
      onAgentInterrupt={options.onAgentInterrupt ?? vi.fn()}
      onAgentResize={options.onAgentResize ?? vi.fn()}
      onStopAgent={options.onStopAgent ?? vi.fn()}
      scanNodeArtifacts={options.scanNodeArtifacts}
      executeAction={options.executeAction ?? vi.fn().mockResolvedValue(actionResponse("12"))}
      onReturnToList={options.onReturnToList ?? vi.fn()}
    />
  );
}

function agentJob(id: string, status: AgentJobSummary["status"]): AgentJobSummary {
  return {
    id,
    runId: "run/one",
    nodeId: "implement",
    provider: "codex",
    status,
    mode: "interactive",
    command: ["codex"],
    cwd: "G:\\project\\release",
    createdAt: "2026-08-06T00:00:00Z",
    updatedAt: "2026-08-06T00:01:00Z",
  };
}

function agentOutput(jobId: string, data: string): AgentOutputSummary {
  return {
    id: `output-${jobId}`,
    jobId,
    sequence: 1,
    kind: "stdout",
    payload: { data },
    createdAt: "2026-08-06T00:01:00Z",
  };
}

function overview(overrides: Partial<RunOverview> = {}): RunOverview {
  const workflow = workflowDefinition();
  const base: RunOverview = {
    run: {
      id: "run/one",
      projectId: "project/one",
      workflowVersionId: "workflow-version-7",
      workflowSnapshot: workflow,
      title: "Release candidate",
      context: { taskGoal: "Ship release candidate", parameters: { dryRun: true, channel: "beta" } },
      executionWorkspace: "G:\\project\\release",
      workspaceMode: "write",
      status: "IN_PROGRESS",
      createdAt: "2026-08-06T00:00:00Z",
      updatedAt: "2026-08-06T00:01:00Z",
    },
    projection: {
      runId: "run/one",
      status: "IN_PROGRESS",
      currentNodeIds: ["implement"],
      nodeStates: { implement: "RUNNING", verify: "READY", review: "PENDING" },
      allowedActions: [
        { id: "submit-artifact", label: "Submit artifact", eventType: "ARTIFACT_SUBMITTED", nodeId: "implement", risk: "low" },
      ],
      blockingReasons: [
        { code: "SOURCE_REQUIRED", message: "Waiting for source bundle", nodeId: "implement" },
        { code: "POLICY_HOLD", message: "Global policy hold" },
        { code: "OTHER_NODE", message: "Review is blocked", nodeId: "review" },
      ],
      revision: "11",
      updatedAt: "2026-08-06T00:01:00Z",
    },
    workflow,
    workspace: {
      id: "lease-1",
      projectId: "project/one",
      runId: "run/one",
      workspacePath: "G:\\project\\release",
      mode: "write",
      status: "active",
      acquiredAt: "2026-08-06T00:00:00Z",
      lastVerifiedAt: "2026-08-06T00:01:00Z",
      releasedAt: null,
      releaseReason: null,
    },
    activity: { activeAgentCount: 1, activeDeploymentCount: 2, lastEventAt: "2026-08-06T00:01:00Z" },
  };
  const merged = { ...base, ...overrides };
  if (!overrides.run) merged.run = { ...base.run };
  if (!overrides.workflow) merged.workflow = workflow;
  return merged;
}

function workflowDefinition(): WorkflowDefinition {
  return {
    id: "immutable-release",
    name: "Immutable release workflow",
    version: "7",
    sourceAdapter: "harness",
    nodes: [
      {
        id: "implement",
        name: "Implement change",
        kind: "agent",
        role: "developer",
        description: "Write the requested change",
        advance: { mode: "manual" },
        requires: [{ type: "artifact", artifactType: "source-bundle", required: true }],
        artifacts: { outputs: [{ id: "notes", name: "release-notes.md", type: "document", required: true, path: "docs/release.md" }] },
      },
      { id: "verify", name: "Verify release", kind: "task" },
      { id: "review", name: "Manual review", kind: "approval" },
    ],
    edges: [
      { id: "implement-verify", from: "implement", to: "verify", condition: "tests pass" },
      { id: "implement-review", from: "implement", to: "review", condition: "manual approval required" },
    ],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
  };
}

function actionResponse(revision: string, status: RunOverview["projection"]["status"] = "IN_PROGRESS"): ExecuteRunActionResponse {
  return { projection: { ...overview().projection, revision, status }, emittedEvents: [] };
}

function runtimeError(status: number | null, code: string, message: string) {
  return new RuntimeClientError(status, code, message, undefined, `corr-${code}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function secondaryLabel(route: string): string {
  return {
    artifacts: "产物",
    terminal: "终端",
    gates: "检查关卡",
    approvals: "审批",
    deployment: "部署",
    audit: "审计",
    recovery: "恢复",
  }[route] ?? route;
}
it("selecting direct transport switches provider and enables chat mode", async () => {
  const startedJob = agentJob("job-new", "RUNNING");
  const onStartAgent = vi.fn().mockResolvedValue(startedJob);
  const agentWorkflow = workflowDefinition();
  agentWorkflow.roles = [{ id: "developer", name: "Developer", provider: "codex", allowedTools: [] }];
  window.location.hash = "#/runs/run%2Fone";
  renderPage({
    overview: overview({ workflow: agentWorkflow }),
    agentJobs: [],
    onStartAgent,
    providerDiagnostics: [
      { id: "codex", executable: "codex", available: true, path: null, version: null, message: "ok" },
      { id: "direct", executable: "direct", available: true, path: null, version: null, message: "已配置" },
    ],
    modelProviders: [{
      id: "mp-1",
      name: "DeepSeek",
      vendor: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "********",
      hasApiKey: true,
      model: "deepseek-chat",
      temperature: 0.7,
      maxTokens: null,
      topP: null,
      systemPrompt: "",
      isDefault: true,
      available: true,
      message: "配置完整",
      createdAt: "2026-08-11T00:00:00Z",
      updatedAt: "2026-08-11T00:00:00Z",
    }],
    activeModelProviderId: "mp-1",
  });

  expect(await screen.findByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
  const agentRegion = await screen.findByRole("region", { name: "Agent 执行" });
  fireEvent.change(within(agentRegion).getByLabelText("Agent 传输"), {
    target: { value: "direct" },
  });
  await waitFor(() =>
    expect(within(agentRegion).getByLabelText("Agent Provider")).toHaveValue("direct"),
  );
  await waitFor(() =>
    expect(within(agentRegion).getByText("聊天界面（模型直连，多轮对话）")).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(within(agentRegion).getByLabelText("模型服务")).toHaveValue("mp-1"),
  );

  fireEvent.change(screen.getByLabelText("Agent 提示词"), { target: { value: "你好" } });
  fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
  await waitFor(() =>
    expect(onStartAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "direct",
        transport: "direct",
        conversational: true,
        modelProviderId: "mp-1",
      }),
    ),
  );
});
