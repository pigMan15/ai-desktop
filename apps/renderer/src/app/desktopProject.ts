export type DesktopProjectApi = {
  selectDirectory(): Promise<string | null>;
};

export function desktopProjectApi(): DesktopProjectApi | null {
  return (window as typeof window & { workflowProject?: DesktopProjectApi }).workflowProject ?? null;
}
