export const routes = [
  { id: "projects", label: "Projects", hash: "#/projects" },
  { id: "runs", label: "Runs", hash: "#/runs" },
  { id: "workflow", label: "Workflow", hash: "#/workflow" },
  { id: "terminal", label: "Terminal", hash: "#/terminal" },
  { id: "gates", label: "Gates", hash: "#/gates" },
  { id: "artifacts", label: "Artifacts", hash: "#/artifacts" },
  { id: "approvals", label: "Approvals", hash: "#/approvals" },
  { id: "recovery", label: "Recovery", hash: "#/recovery" },
  { id: "settings", label: "Settings", hash: "#/settings" },
] as const;

export type RouteId = (typeof routes)[number]["id"];

export function normalizeRoute(hash: string): RouteId {
  return routes.find((route) => route.hash === hash)?.id ?? "projects";
}

export function routeHash(routeId: RouteId): string {
  return routes.find((route) => route.id === routeId)?.hash ?? "#/projects";
}
