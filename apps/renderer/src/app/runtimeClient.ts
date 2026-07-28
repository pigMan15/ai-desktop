import type { RunProjection } from "@workflow-platform/contracts";

export type RuntimeWorkbenchState = {
  connection: "connected" | "unavailable";
  projectName: string;
  workflowName: string;
  projection: RunProjection;
  timeline: Array<{ id: string; type: string; nodeId?: string; createdAt: string }>;
  artifacts: Array<{ id: string; type: string; uri: string; contentHash: string }>;
  approvals: Array<{ id: string; status: string; comment?: string }>;
  gates: Array<{ id: string; status: string; evidence: string[] }>;
  agentJobs: AgentJobSummary[];
  agentOutput: AgentOutputSummary[];
};

type RuntimeImportResult = {
  projectId: string;
  workflowVersionId: string;
  workflowId?: string;
  workflowName?: string;
};

export type AgentJobSummary = {
  id: string;
  runId: string;
  nodeId: string;
  provider: "codex" | "claude" | "fake";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  command: string[];
  cwd: string;
  pid?: number | null;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentOutputSummary = {
  id: string;
  jobId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

const RUNTIME_API_BASE_URL =
  import.meta.env.VITE_RUNTIME_API_BASE_URL ?? "http://127.0.0.1:8765";
const RUNTIME_PROJECT_PATH = import.meta.env.VITE_RUNTIME_PROJECT_PATH;
const RUNTIME_ARTIFACT_PATH = import.meta.env.VITE_RUNTIME_ARTIFACT_PATH;

const AGENT_ACTOR = { id: "renderer-agent", type: "agent", source: "renderer", trusted: false };
const HUMAN_ACTOR = { id: "renderer-human", type: "human", source: "runtime", trusted: true };
const VERIFIER_ACTOR = {
  id: "renderer-verifier",
  type: "verifier",
  source: "runtime",
  trusted: true,
};

export async function loadWorkbenchState(): Promise<RuntimeWorkbenchState> {
  const config = readRuntimeConfig();
  if (!config.projectPath || !config.artifactPath) {
    return demoWorkbenchState("unavailable");
  }

  try {
    return await loadRuntimeState({
      apiBaseUrl: config.apiBaseUrl,
      projectPath: config.projectPath,
      artifactPath: config.artifactPath,
      now: new Date().toISOString(),
    });
  } catch {
    return demoWorkbenchState("unavailable");
  }
}

export async function loadRuntimeState({
  apiBaseUrl,
  projectPath,
  artifactPath,
  now,
}: {
  apiBaseUrl: string;
  projectPath: string;
  artifactPath: string;
  now: string;
}): Promise<RuntimeWorkbenchState> {
  const client = createRuntimeClient(apiBaseUrl);
  await client.health();

  const imported = await client.importProject(projectPath, now);
  const runTitle = `Renderer P1 ${now} ${globalThis.crypto?.randomUUID?.() ?? Math.random()}`;
  let projection = await client.createRun(imported.workflowVersionId, runTitle, now);
  projection = await client.startNode(projection.runId, "plan", projection.revision, now);
  projection = await client.submitArtifact(
    projection.runId,
    "plan",
    artifactPath,
    "plan",
    projection.revision,
    now,
  );
  projection = await client.decideApproval(
    projection.runId,
    "plan",
    "approved",
    "Renderer P1 人工审批通过",
    projection.revision,
    now,
  );
  projection = await client.submitGate(
    projection.runId,
    "plan",
    "plan-ready",
    "passed",
    [`file://${artifactPath}#p1-e2e`],
    projection.revision,
    now,
  );

  const [timeline, artifacts, approvals, gates] = await Promise.all([
    client.getTimeline(projection.runId),
    client.listArtifacts(projection.runId),
    client.listApprovals(projection.runId),
    client.listGates(projection.runId),
  ]);

  return {
    connection: "connected",
    projectName: projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? imported.projectId,
    workflowName: imported.workflowName ?? imported.workflowId ?? imported.workflowVersionId,
    projection,
    timeline,
    artifacts,
    approvals,
    gates,
    agentJobs: [],
    agentOutput: [],
  };
}

export function createRuntimeClient(apiBaseUrl: string) {
  return {
    health: () => request(apiBaseUrl, "/health"),
    importProject: (projectPath: string, now: string) =>
      request<RuntimeImportResult>(apiBaseUrl, "/projects/import", { projectPath, now }),
    createRun: (workflowVersionId: string, title: string, now: string) =>
      request<RunProjection>(apiBaseUrl, "/runs", { workflowVersionId, title, now }),
    startNode: (runId: string, nodeId: string, expectedRevision: string, now: string) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/transition`, {
        eventType: "NODE_STARTED",
        nodeId,
        actor: AGENT_ACTOR,
        expectedRevision,
        now,
      }),
    submitArtifact: (
      runId: string,
      nodeId: string,
      artifactPath: string,
      artifactType: string,
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/artifacts`, {
        nodeId,
        artifactPath,
        artifactType,
        actor: AGENT_ACTOR,
        expectedRevision,
        now,
      }),
    decideApproval: (
      runId: string,
      nodeId: string,
      decision: "approved" | "rejected",
      comment: string,
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/approvals/${nodeId}/decide`, {
        decision,
        actor: HUMAN_ACTOR,
        comment,
        expectedRevision,
        now,
      }),
    submitGate: (
      runId: string,
      nodeId: string,
      gateId: string,
      status: "passed" | "failed" | "waived",
      evidence: string[],
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/gates`, {
        nodeId,
        gateId,
        status,
        evidence,
        waiverReason: null,
        actor: VERIFIER_ACTOR,
        expectedRevision,
        now,
      }),
    getTimeline: (runId: string) =>
      request<RuntimeWorkbenchState["timeline"]>(apiBaseUrl, `/runs/${runId}/timeline`),
    listArtifacts: (runId: string) =>
      request<RuntimeWorkbenchState["artifacts"]>(apiBaseUrl, `/runs/${runId}/artifacts`),
    listApprovals: (runId: string) =>
      request<RuntimeWorkbenchState["approvals"]>(apiBaseUrl, `/runs/${runId}/approvals`),
    listGates: (runId: string) =>
      request<RuntimeWorkbenchState["gates"]>(apiBaseUrl, `/runs/${runId}/gates`),
    getProjection: (runId: string) => request<RunProjection>(apiBaseUrl, `/runs/${runId}/projection`),
    startAgentJob: (
      runId: string,
      nodeId: string,
      provider: AgentJobSummary["provider"],
      prompt: string,
      now: string,
    ) =>
      request<AgentJobSummary>(apiBaseUrl, `/runs/${runId}/agents`, {
        nodeId,
        provider,
        prompt,
        actor: AGENT_ACTOR,
        allowedTools: [],
        timeoutSeconds: 300,
        maxOutputBytes: 1_000_000,
        now,
      }),
    listAgentJobs: (runId: string) =>
      request<AgentJobSummary[]>(apiBaseUrl, `/runs/${runId}/agents`),
    listAgentOutput: (runId: string, jobId: string, afterSequence: number) =>
      request<AgentOutputSummary[]>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/output?afterSequence=${afterSequence}`,
      ),
    cancelAgentJob: (runId: string, jobId: string) =>
      request<AgentJobSummary>(apiBaseUrl, `/runs/${runId}/agents/${jobId}/cancel`, {}),
  };
}

function readRuntimeConfig() {
  const params =
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return {
    apiBaseUrl: params.get("runtimeApiBaseUrl") ?? RUNTIME_API_BASE_URL,
    projectPath: params.get("runtimeProjectPath") ?? RUNTIME_PROJECT_PATH,
    artifactPath: params.get("runtimeArtifactPath") ?? RUNTIME_ARTIFACT_PATH,
  };
}

async function request<T>(apiBaseUrl: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Runtime API ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function demoWorkbenchState(connection: RuntimeWorkbenchState["connection"]): RuntimeWorkbenchState {
  return {
    connection,
    projectName: "demo-workflow",
    workflowName: "Demo Workflow",
    projection: {
      runId: "run-demo",
      status: "REVIEWING",
      currentNodeIds: ["plan"],
      nodeStates: { plan: "AWAITING_APPROVAL" },
      allowedActions: [],
      blockingReasons: [{ code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "plan" }],
      revision: "3",
      updatedAt: "2026-07-28T00:00:00Z",
    },
    timeline: [
      { id: "event-3", type: "ARTIFACT_SUBMITTED", nodeId: "plan", createdAt: "2026-07-28T00:00:00Z" },
    ],
    artifacts: [{ id: "artifact-1", type: "plan", uri: "artifact://plan.md", contentHash: "sha256:demo" }],
    approvals: [{ id: "approval-1", status: "pending" }],
    gates: [{ id: "gate-1", status: "waiting", evidence: ["artifact:plan"] }],
    agentJobs: [],
    agentOutput: [],
  };
}
