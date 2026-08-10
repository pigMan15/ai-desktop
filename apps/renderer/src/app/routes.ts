export const routes = [
  { id: "roles", label: "角色库", hash: "#/roles" },
  { id: "projects", label: "项目", hash: "#/projects" },
  { id: "runs", label: "运行", hash: "#/runs" },
  { id: "workflow", label: "工作流", hash: "#/workflow" },
  { id: "terminal", label: "终端", hash: "#/terminal" },
  { id: "gates", label: "门禁", hash: "#/gates" },
  { id: "artifacts", label: "产物", hash: "#/artifacts" },
  { id: "approvals", label: "审批", hash: "#/approvals" },
  { id: "knowledge", label: "知识库", hash: "#/knowledge" },
  { id: "audit", label: "审计", hash: "#/audit" },
  { id: "recovery", label: "恢复", hash: "#/recovery" },
  { id: "settings", label: "设置", hash: "#/settings" },
] as const;

export type RouteId = (typeof routes)[number]["id"];

export type WorkflowRoute =
  | { mode: "library" }
  | { mode: "new" }
  | { mode: "edit"; workflowId: string };

export type RunRoute =
  | { mode: "list" }
  | { mode: "new" }
  | { mode: "detail"; runId: string }
  | { mode: "agent"; runId: string; jobId: string }
  | { mode: "unknown" };

export type RunContext = { projectId: string; runId: string; jobId?: string };

export type ScopedRunRoute =
  | {
      mode: "artifacts" | "gates" | "approvals" | "deployment" | "audit" | "recovery";
      context: RunContext;
    }
  | { mode: "invalid" }
  | { mode: "none" };

type RunModule = Exclude<ScopedRunRoute["mode"], "invalid" | "none">;

const runModules = ["artifacts", "gates", "approvals", "deployment", "audit", "recovery"] as const;

export function normalizeRoute(hash: string): RouteId {
  if (parseRunRoute(hash).mode !== "unknown") {
    return "runs";
  }

  const scopedRoute = parseScopedNavigationRoute(hash);
  if (scopedRoute.mode === "deployment") {
    return "runs";
  }
  if (scopedRoute.mode !== "invalid" && scopedRoute.mode !== "none") {
    return scopedRoute.mode;
  }
  if (parseWorkflowRoute(hash).mode !== "library" || hash.split("?")[0] === "#/workflow") {
    return "workflow";
  }
  return routes.find((route) => route.hash === hash)?.id ?? "projects";
}

export function routeHash(routeId: RouteId): string {
  return routes.find((route) => route.id === routeId)?.hash ?? "#/projects";
}

export function parseRunRoute(hash: string): RunRoute {
  const pathname = hash.split("?")[0];
  if (pathname === "#/runs") return { mode: "list" };
  if (pathname === "#/runs/new") return { mode: "new" };

  const agentMatch = pathname.match(/^#\/runs\/([^/]+)\/agents\/([^/]+)$/);
  if (agentMatch) {
    try {
      const runId = decodeURIComponent(agentMatch[1]);
      const jobId = decodeURIComponent(agentMatch[2]);
      return isNonBlank(runId) && isNonBlank(jobId)
        ? { mode: "agent", runId, jobId }
        : { mode: "unknown" };
    } catch {
      return { mode: "unknown" };
    }
  }

  const detailMatch = pathname.match(/^#\/runs\/([^/]+)$/);
  if (!detailMatch) return { mode: "unknown" };

  try {
    const runId = decodeURIComponent(detailMatch[1]);
    return runId ? { mode: "detail", runId } : { mode: "unknown" };
  } catch {
    return { mode: "unknown" };
  }
}

export function parseScopedRunRoute(hash: string, activeProjectId: string): ScopedRunRoute {
  const queryIndex = hash.indexOf("?");
  const pathname = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : hash.slice(queryIndex + 1);
  const module = runModules.find((candidate) => pathname === `#/${candidate}`);
  if (!module) {
    return { mode: "none" };
  }
  if (!isNonBlank(activeProjectId) || !hasValidQueryEncoding(query)) {
    return { mode: "invalid" };
  }

  const parameters = new URLSearchParams(query);
  const projectIds = parameters.getAll("projectId");
  const runIds = parameters.getAll("runId");
  if (projectIds.length !== 1 || runIds.length !== 1) {
    return { mode: "invalid" };
  }

  const projectId = projectIds[0];
  const runId = runIds[0];
  if (!isNonBlank(projectId) || !isNonBlank(runId) || projectId !== activeProjectId) {
    return { mode: "invalid" };
  }

  return { mode: module, context: { projectId, runId } };
}

export const buildRunDetailHash = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;

export const buildRunAgentExecutorHash = (runId: string, jobId: string) =>
  `#/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(jobId)}`;

export function buildRunModuleHash(module: RunModule, context: RunContext) {
  const query = new URLSearchParams({ projectId: context.projectId, runId: context.runId });
  return `#/${module}?${query.toString()}`;
}

export function parseWorkflowRoute(hash: string): WorkflowRoute {
  const pathname = hash.split("?")[0];
  if (pathname === "#/workflow/new") return { mode: "new" };
  const editMatch = pathname.match(/^#\/workflow\/([^/]+)$/);
  if (editMatch && editMatch[1]) return { mode: "edit", workflowId: decodeURIComponent(editMatch[1]) };
  return { mode: "library" };
}

export function isKnownRouteHash(hash: string) {
  const pathname = hash.split("?")[0];
  return (
    parseRunRoute(hash).mode !== "unknown" ||
    !["invalid", "none"].includes(parseScopedNavigationRoute(hash).mode) ||
    routes.some((route) => route.hash === pathname) ||
    pathname === "#/workflow/new" ||
    /^#\/workflow\/[^/]+$/.test(pathname)
  );
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function hasValidQueryEncoding(query: string): boolean {
  try {
    for (const field of query.split("&")) {
      const separatorIndex = field.indexOf("=");
      const key = separatorIndex === -1 ? field : field.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? "" : field.slice(separatorIndex + 1);
      decodeURIComponent(key.replace(/\+/g, " "));
      decodeURIComponent(value.replace(/\+/g, " "));
    }
    return true;
  } catch {
    return false;
  }
}

function parseScopedNavigationRoute(hash: string): ScopedRunRoute {
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) {
    return { mode: "none" };
  }
  const query = hash.slice(queryIndex + 1);
  if (!hasValidQueryEncoding(query)) {
    return { mode: "invalid" };
  }
  const projectIds = new URLSearchParams(query).getAll("projectId");
  if (projectIds.length !== 1 || !isNonBlank(projectIds[0])) {
    return { mode: "invalid" };
  }
  return parseScopedRunRoute(hash, projectIds[0]);
}
