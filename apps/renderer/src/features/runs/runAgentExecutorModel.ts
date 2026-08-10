import type { AgentJobSummary, AgentOutputSummary } from "../../app/runtimeClient";
import type { TerminalViewportOutput } from "../terminal/TerminalViewport";

const newest = (jobs: AgentJobSummary[]): AgentJobSummary | null =>
  [...jobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;

export function selectAgentJob(
  jobs: AgentJobSummary[],
  requestedJobId: string | null,
): AgentJobSummary | null {
  const requested = requestedJobId
    ? jobs.find((candidate) => candidate.id === requestedJobId)
    : undefined;
  if (requested) {
    return requested;
  }

  const active = jobs.filter(
    (candidate) => candidate.status === "RUNNING" || candidate.status === "QUEUED",
  );
  return newest(active) ?? newest(jobs);
}

const persistedData = (event: AgentOutputSummary): string => {
  if (typeof event.payload.data === "string") {
    return event.payload.data;
  }
  if (typeof event.payload.text === "string") {
    return event.payload.text;
  }
  return JSON.stringify(event.payload);
};

export function agentViewportOutput(
  jobId: string,
  persisted: AgentOutputSummary[],
  liveByJob: Record<string, TerminalViewportOutput[]>,
): TerminalViewportOutput[] {
  const live = liveByJob[jobId];
  if (live?.length) {
    return live;
  }

  return persisted
    .filter((event) => event.jobId === jobId)
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => ({ sequence: event.sequence, data: persistedData(event) }));
}
