import type { AgentOutputSummary } from "./runtimeClient";

export function mergeAgentOutput(
  current: AgentOutputSummary[],
  incoming: AgentOutputSummary[],
): AgentOutputSummary[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.jobId.localeCompare(right.jobId) || left.sequence - right.sequence,
  );
}
