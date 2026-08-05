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
  | { mode: "unknown" };

export function normalizeRoute(hash: string): RouteId {
  if (parseRunRoute(hash).mode !== "unknown") {
    return "runs";
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

  const detailMatch = pathname.match(/^#\/runs\/([^/]+)$/);
  if (!detailMatch) return { mode: "unknown" };

  try {
    const runId = decodeURIComponent(detailMatch[1]);
    return runId ? { mode: "detail", runId } : { mode: "unknown" };
  } catch {
    return { mode: "unknown" };
  }
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
    routes.some((route) => route.hash === pathname) ||
    pathname === "#/workflow/new" ||
    /^#\/workflow\/[^/]+$/.test(pathname)
  );
}
