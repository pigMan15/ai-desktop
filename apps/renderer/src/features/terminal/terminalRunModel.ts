import type {
  RunListResponse,
  RunStatus,
  RunSummaryProjection,
} from "@workflow-platform/contracts";

export type TerminalRunOption = {
  id: string;
  title: string;
  status: RunStatus;
  workflowName: string;
  workflowVersion: string;
  createdAt: string;
  bindable: boolean;
};

const BINDABLE_STATUSES = new Set<RunStatus>([
  "CREATED",
  "IN_PROGRESS",
  "REVIEWING",
  "BLOCKED",
  "PAUSED",
]);

export function isTerminalRunBindable(status: string): boolean {
  return BINDABLE_STATUSES.has(status as RunStatus);
}

export function buildTerminalRunOptions(
  runs: RunSummaryProjection[],
  activeRunId: string | null,
): TerminalRunOption[] {
  return runs
    .map((run) => ({
      id: run.id,
      title: run.title,
      status: run.status,
      workflowName: run.workflowName,
      workflowVersion: run.workflowVersion,
      createdAt: run.createdAt,
      bindable: isTerminalRunBindable(run.status),
    }))
    .sort((left, right) => {
      if (left.id === activeRunId) return -1;
      if (right.id === activeRunId) return 1;
      return right.createdAt.localeCompare(left.createdAt);
    });
}

export function filterTerminalRunOptions(
  options: TerminalRunOption[],
  query: string,
  showEnded: boolean,
): TerminalRunOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  return options.filter((option) => {
    if (!showEnded && !option.bindable) return false;
    if (!normalized) return true;
    return option.title.toLocaleLowerCase().includes(normalized)
      || option.id.toLocaleLowerCase().includes(normalized);
  });
}

export async function loadAllTerminalRuns(
  loadPage: (cursor?: string) => Promise<RunListResponse>,
): Promise<RunSummaryProjection[]> {
  const runs: RunSummaryProjection[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await loadPage(cursor);
    runs.push(...page.items);
    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error(`Repeated project Run cursor: ${nextCursor}`);
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return runs;
}
