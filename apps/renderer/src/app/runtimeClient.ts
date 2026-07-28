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
};

type RuntimeImportResult = {
  projectId: string;
  workflowVersionId: string;
  workflowId?: string;
  workflowName?: string;
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
  await request(apiBaseUrl, "/health");

  const imported = await request<RuntimeImportResult>(apiBaseUrl, "/projects/import", {
    projectPath,
    now,
  });
  const runTitle = `Renderer P1 ${now} ${globalThis.crypto?.randomUUID?.() ?? Math.random()}`;
  let projection = await request<RunProjection>(apiBaseUrl, "/runs", {
    workflowVersionId: imported.workflowVersionId,
    title: runTitle,
    now,
  });
  projection = await request<RunProjection>(
    apiBaseUrl,
    `/runs/${projection.runId}/transition`,
    {
      eventType: "NODE_STARTED",
      nodeId: "plan",
      actor: AGENT_ACTOR,
      expectedRevision: projection.revision,
      now,
    },
  );
  projection = await request<RunProjection>(apiBaseUrl, `/runs/${projection.runId}/artifacts`, {
    nodeId: "plan",
    artifactPath,
    artifactType: "plan",
    actor: AGENT_ACTOR,
    expectedRevision: projection.revision,
    now,
  });
  projection = await request<RunProjection>(
    apiBaseUrl,
    `/runs/${projection.runId}/approvals/plan/decide`,
    {
      decision: "approved",
      actor: HUMAN_ACTOR,
      comment: "Renderer P1 人工审批通过",
      expectedRevision: projection.revision,
      now,
    },
  );
  projection = await request<RunProjection>(apiBaseUrl, `/runs/${projection.runId}/gates`, {
    nodeId: "plan",
    gateId: "plan-ready",
    status: "passed",
    evidence: [`file://${artifactPath}#p1-e2e`],
    waiverReason: null,
    actor: VERIFIER_ACTOR,
    expectedRevision: projection.revision,
    now,
  });

  const [timeline, artifacts, approvals, gates] = await Promise.all([
    request<RuntimeWorkbenchState["timeline"]>(apiBaseUrl, `/runs/${projection.runId}/timeline`),
    request<RuntimeWorkbenchState["artifacts"]>(apiBaseUrl, `/runs/${projection.runId}/artifacts`),
    request<RuntimeWorkbenchState["approvals"]>(apiBaseUrl, `/runs/${projection.runId}/approvals`),
    request<RuntimeWorkbenchState["gates"]>(apiBaseUrl, `/runs/${projection.runId}/gates`),
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
  };
}
