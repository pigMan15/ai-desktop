export type WorkspaceSession = {
  apiBaseUrl: string;
  projectPath: string;
  projectId?: string;
  workflowVersionId: string;
  projectName: string;
  workflowName: string;
  runId: string | null;
};

const STORAGE_KEY = "ai-workflow-platform.workspace-session.v1";
const DEFAULT_RUNTIME_API_BASE_URL =
  import.meta.env.VITE_RUNTIME_API_BASE_URL ?? "http://127.0.0.1:8765";

export function loadWorkspaceSession(): WorkspaceSession {
  const fallback = emptyWorkspaceSession();
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) {
      return fallback;
    }
    return normalizeSession(JSON.parse(value));
  } catch {
    return fallback;
  }
}

export function saveWorkspaceSession(session: WorkspaceSession): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSession(session)));
}

export function emptyWorkspaceSession(): WorkspaceSession {
  return {
    apiBaseUrl: DEFAULT_RUNTIME_API_BASE_URL,
    projectPath: "",
    projectId: "",
    workflowVersionId: "",
    projectName: "",
    workflowName: "",
    runId: null,
  };
}

function normalizeSession(value: unknown): WorkspaceSession {
  const session = value as Partial<WorkspaceSession> | null;
  return {
    apiBaseUrl:
      typeof session?.apiBaseUrl === "string" && session.apiBaseUrl.trim()
        ? session.apiBaseUrl
        : DEFAULT_RUNTIME_API_BASE_URL,
    projectPath: typeof session?.projectPath === "string" ? session.projectPath : "",
    projectId: typeof session?.projectId === "string" ? session.projectId : "",
    workflowVersionId:
      typeof session?.workflowVersionId === "string" ? session.workflowVersionId : "",
    projectName: typeof session?.projectName === "string" ? session.projectName : "",
    workflowName: typeof session?.workflowName === "string" ? session.workflowName : "",
    runId: typeof session?.runId === "string" && session.runId ? session.runId : null,
  };
}
