import type { NodeArtifactScan } from "../../app/runtimeClient";

const STORAGE_PREFIX = "workflow-run-artifact-scan:";

function storageKey(projectId: string, runId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(runId)}`;
}

export function loadRunArtifactScan(projectId: string, runId: string): NodeArtifactScan | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(projectId, runId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<NodeArtifactScan>;
    if (
      value.runId !== runId
      || typeof value.nodeId !== "string"
      || !Array.isArray(value.registered)
      || !Array.isArray(value.unchanged)
      || !Array.isArray(value.missing)
      || !Array.isArray(value.invalid)
      || !value.projection
    ) {
      window.sessionStorage.removeItem(storageKey(projectId, runId));
      return null;
    }
    return value as NodeArtifactScan;
  } catch {
    return null;
  }
}

export function saveRunArtifactScan(projectId: string, runId: string, result: NodeArtifactScan): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(projectId, runId), JSON.stringify(result));
  } catch {
    // Storage may be unavailable or full; the in-memory result remains usable.
  }
}

export function clearRunArtifactScan(projectId: string, runId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(projectId, runId));
  } catch {
    // Ignore storage failures; clearing the in-memory state is still sufficient.
  }
}
