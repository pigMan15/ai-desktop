import type { WorkflowDefinition } from "@workflow-platform/contracts";

const STORAGE_PREFIX = "workflow-run-workflow-snapshot:";

function storageKey(projectId: string, runId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(runId)}`;
}

export function loadRunWorkflowSnapshot(projectId: string, runId: string): WorkflowDefinition | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey(projectId, runId)) ?? "null") as unknown;
    return isWorkflowSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveRunWorkflowSnapshot(projectId: string, runId: string, workflow: WorkflowDefinition): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(projectId, runId), JSON.stringify(workflow));
  } catch {
    // Storage may be unavailable; the in-memory overview remains usable.
  }
}

function isWorkflowSnapshot(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges);
}
