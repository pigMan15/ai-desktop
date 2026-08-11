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

export type AgentChatMessage = {
  sequence: number;
  kind: "message" | "permission" | "turn" | "error";
  text: string;
};

export function isConversationalJob(job: AgentJobSummary): boolean {
  return job.metadata?.conversational === true;
}

function mapChatEvent(event: AgentOutputSummary): AgentChatMessage {
  if (event.kind === "acp.permission") {
    const target = typeof event.payload.target === "string" ? event.payload.target : "";
    const status = typeof event.payload.status === "string" ? event.payload.status : "";
    return {
      sequence: event.sequence,
      kind: "permission" as const,
      text: "权限请求" + (status ? "（" + status + "）" : "") + (target ? "：" + target : ""),
    };
  }
  if (event.kind === "acp.turn") {
    return {
      sequence: event.sequence,
      kind: "turn" as const,
      text: typeof event.payload.text === "string" ? event.payload.text : "",
    };
  }
  if (event.kind === "acp.error") {
    return {
      sequence: event.sequence,
      kind: "error" as const,
      text: typeof event.payload.text === "string" ? event.payload.text : "??????",
    };
  }
  return {
    sequence: event.sequence,
    kind: "message" as const,
    text: typeof event.payload.text === "string" ? event.payload.text : persistedData(event),
  };
}

export function agentChatMessages(
  jobId: string,
  persisted: AgentOutputSummary[],
): AgentChatMessage[] {
  const events = persisted
    .filter(
      (event) =>
        event.jobId === jobId &&
        (event.kind === "acp.message" ||
          event.kind === "acp.permission" ||
          event.kind === "acp.turn" ||
          event.kind === "acp.error"),
    )
    .sort((left, right) => left.sequence - right.sequence);

  // Stream deltas are coalesced by messageId so one reply renders as one bubble.
  const streamLatest = new Map<string, AgentOutputSummary>();
  const streamFirstSequence = new Map<string, number>();
  const standalone: AgentOutputSummary[] = [];
  for (const event of events) {
    const messageId =
      event.kind === "acp.message" && typeof event.payload.messageId === "string"
        ? event.payload.messageId
        : "";
    if (messageId) {
      if (!streamFirstSequence.has(messageId)) streamFirstSequence.set(messageId, event.sequence);
      streamLatest.set(messageId, event);
    } else {
      standalone.push(event);
    }
  }

  const items: Array<{ sequence: number; message: AgentChatMessage }> = [];
  for (const [messageId, latest] of streamLatest) {
    items.push({
      sequence: streamFirstSequence.get(messageId) ?? latest.sequence,
      message: {
        ...mapChatEvent(latest),
        sequence: streamFirstSequence.get(messageId) ?? latest.sequence,
      },
    });
  }
  for (const event of standalone) {
    items.push({ sequence: event.sequence, message: mapChatEvent(event) });
  }
  return items.sort((left, right) => left.sequence - right.sequence).map((item) => item.message);
}
