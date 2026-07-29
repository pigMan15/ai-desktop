export const routes = [
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

export function normalizeRoute(hash: string): RouteId {
  return routes.find((route) => route.hash === hash)?.id ?? "projects";
}

export function routeHash(routeId: RouteId): string {
  return routes.find((route) => route.id === routeId)?.hash ?? "#/projects";
}
