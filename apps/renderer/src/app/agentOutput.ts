import type { AgentOutputSummary } from "./runtimeClient";

const MAX_SCROLLBACK_EVENTS_PER_JOB = 2_000;

export function isInteractiveAgentSessionClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("/interactive-session/output failed with 409") ||
    message.includes("AGENT_INTERACTIVE_SESSION_STATE_INVALID")
  );
}

export function isInteractiveAgentOutputLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AGENT_OUTPUT_LIMIT: interactive CLI output exceeded");
}

export function isTerminalSessionMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Terminal session not found:");
}

export function mergeAgentOutput(
  current: AgentOutputSummary[],
  incoming: AgentOutputSummary[],
): AgentOutputSummary[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  const outputByJob = new Map<string, AgentOutputSummary[]>();
  for (const event of byId.values()) {
    const events = outputByJob.get(event.jobId) ?? [];
    events.push(event);
    outputByJob.set(event.jobId, events);
  }
  return [...outputByJob.entries()]
    .sort(([leftJobId], [rightJobId]) => leftJobId.localeCompare(rightJobId))
    .flatMap(([, events]) =>
      events
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-MAX_SCROLLBACK_EVENTS_PER_JOB),
    );
}
