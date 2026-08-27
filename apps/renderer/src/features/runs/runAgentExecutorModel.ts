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

export type AgentChatTool = {
  title?: string;
  status?: string;
  text?: string;
  itemId?: string;
};

export type AgentChatMessage = {
  sequence: number;
  kind: "message" | "user" | "permission" | "turn" | "error" | "tool";
  text: string;
  tool?: AgentChatTool;
  createdAt?: string;
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
      createdAt: event.createdAt,
      text: "权限请求" + (status ? "（" + status + "）" : "") + (target ? "：" + target : ""),
    };
  }
  if (event.kind === "chat.user") {
    return {
      sequence: event.sequence,
      kind: "user" as const,
      createdAt: event.createdAt,
      text: typeof event.payload.text === "string" ? event.payload.text : "",
    };
  }
  if (event.kind === "acp.turn") {
    return {
      sequence: event.sequence,
      kind: "turn" as const,
      createdAt: event.createdAt,
      text: typeof event.payload.text === "string" ? event.payload.text : "",
    };
  }
  if (event.kind === "acp.error") {
    return {
      sequence: event.sequence,
      kind: "error" as const,
      createdAt: event.createdAt,
      text: typeof event.payload.text === "string" ? event.payload.text : "??????",
    };
  }
  if (event.kind === "tool") {
    const title = typeof event.payload.title === "string" ? event.payload.title : "命令执行";
    const status = typeof event.payload.status === "string" ? event.payload.status : "";
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    return {
      sequence: event.sequence,
      kind: "tool" as const,
      createdAt: event.createdAt,
      text,
      tool: {
        title,
        status,
        text,
        itemId: typeof event.payload.itemId === "string" ? event.payload.itemId : undefined,
      },
    };
  }
  return {
    sequence: event.sequence,
    kind: "message" as const,
    createdAt: event.createdAt,
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
          event.kind === "chat.user" ||
          event.kind === "acp.permission" ||
          event.kind === "acp.turn" ||
          event.kind === "acp.error" ||
          event.kind === "tool"),
    )
    .sort((left, right) => left.sequence - right.sequence);

  // Stream deltas share a messageId; concatenate them in order so one reply
  // renders as one bubble with the full text.
  const streamDeltas = new Map<string, string[]>();
  const streamFirstSequence = new Map<string, number>();
  const streamFirstCreatedAt = new Map<string, string>();
  // Tool/command executions share an itemId (item.started + item.completed);
  // keep one block per command and let the latest event win (running -> completed).
  const toolByItem = new Map<string, { sequence: number; createdAt?: string; message: AgentChatMessage }>();
  const standalone: AgentOutputSummary[] = [];
  for (const event of events) {
    const messageId =
      event.kind === "acp.message" && typeof event.payload.messageId === "string"
        ? event.payload.messageId
        : "";
    if (messageId) {
      let deltas = streamDeltas.get(messageId);
      if (!deltas) {
        deltas = [];
        streamDeltas.set(messageId, deltas);
        streamFirstSequence.set(messageId, event.sequence);
        streamFirstCreatedAt.set(messageId, event.createdAt);
      }
      deltas.push(typeof event.payload.text === "string" ? event.payload.text : "");
    } else if (event.kind === "tool" && typeof event.payload.itemId === "string" && event.payload.itemId) {
      const itemId = event.payload.itemId;
      const mapped = mapChatEvent(event) as AgentChatMessage;
      const existing = toolByItem.get(itemId);
      if (!existing || event.sequence > existing.sequence) {
        toolByItem.set(itemId, {
          sequence: existing ? existing.sequence : event.sequence,
          createdAt: existing?.createdAt ?? event.createdAt,
          message: mapped,
        });
      }
    } else {
      standalone.push(event);
    }
  }

  const items: Array<{ sequence: number; message: AgentChatMessage }> = [];
  for (const [messageId, deltas] of streamDeltas) {
    const sequence = streamFirstSequence.get(messageId) ?? 0;
    items.push({
      sequence,
      message: { sequence, kind: "message", text: deltas.join(""), createdAt: streamFirstCreatedAt.get(messageId) },
    });
  }
  for (const [itemId, entry] of toolByItem) {
    void itemId;
    items.push({
      sequence: entry.sequence,
      message: entry.createdAt ? { ...entry.message, createdAt: entry.createdAt } : entry.message,
    });
  }
  for (const event of standalone) {
    items.push({ sequence: event.sequence, message: mapChatEvent(event) });
  }
  return items.sort((left, right) => left.sequence - right.sequence).map((item) => item.message);
}
