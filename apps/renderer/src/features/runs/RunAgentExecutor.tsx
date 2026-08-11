import { Gem, Hexagon, Orbit, Sparkles, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentPermissionRequest } from "@workflow-platform/contracts";
import type { AgentJobSummary, AgentOutputSummary } from "../../app/runtimeClient";
import { buildRunAgentExecutorHash } from "../../app/routes";
import { TerminalViewport, type TerminalViewportOutput } from "../terminal/TerminalViewport";
import { agentIdentities, type AgentIconName } from "./runAgentIdentity";
import { agentChatMessages, agentViewportOutput, isConversationalJob, selectAgentJob } from "./runAgentExecutorModel";
import { AgentChatView } from "./AgentChatView";

export type RunAgentSessionState = {
  writable: boolean;
  persistenceLimited?: boolean;
};

export type RunAgentExecutorProps = {
  runId: string;
  jobs: AgentJobSummary[];
  persistedOutput: AgentOutputSummary[];
  liveOutputByJob: Record<string, TerminalViewportOutput[]>;
  sessionStateByJob: Record<string, RunAgentSessionState>;
  selectedJobId: string | null;
  onSelectJob(jobId: string): void;
  onInput(jobId: string, data: string): Promise<void> | void;
  onInterrupt(jobId: string): Promise<void> | void;
  onResize(jobId: string, columns: number, rows: number): Promise<void> | void;
  onStop(jobId: string): Promise<void> | void;
  permissionsByJob?: Record<string, AgentPermissionRequest[]>;
  onContinueConversation?(jobId: string, message: string): Promise<void> | void;
  onDecidePermission?(jobId: string, requestId: string, decision: "allow" | "deny", reason?: string): Promise<void> | void;
  showFullScreenLink?: boolean;
  fullScreen?: boolean;
};

const shortJobId = (jobId: string) =>
  jobId.length > 12 ? `${jobId.slice(0, 12)}...` : jobId;

const AGENT_STATUS_LABELS: Record<AgentJobSummary["status"], string> = {
  QUEUED: "排队中",           // ???
  RUNNING: "执行中",          // ???
  AWAITING_INPUT: "等待回复",  // ????
  COMPLETED: "已完成",        // ???
  FAILED: "失败",                 // ??
  CANCELLED: "已取消",        // ???
};

const agentStatusLabel = (status: AgentJobSummary["status"]): string =>
  AGENT_STATUS_LABELS[status] ?? status;

const AGENT_ICONS = {
  gem: Gem,
  sparkles: Sparkles,
  hexagon: Hexagon,
  orbit: Orbit,
} satisfies Record<AgentIconName, LucideIcon>;

export function RunAgentExecutor({
  runId,
  jobs,
  persistedOutput,
  liveOutputByJob,
  sessionStateByJob,
  selectedJobId,
  onSelectJob,
  onInput,
  onInterrupt,
  onResize,
  onStop,
  permissionsByJob,
  onContinueConversation,
  onDecidePermission,
  showFullScreenLink = false,
  fullScreen = false,
}: RunAgentExecutorProps) {
  const selectedJob = selectAgentJob(jobs, selectedJobId);
  const identities = agentIdentities(jobs.map((job) => job.id));
  const [view, setView] = useState<"chat" | "terminal">("terminal");
  const viewLockedRef = useRef(false);
  const conversational = Boolean(selectedJob && isConversationalJob(selectedJob));

  useEffect(() => {
    if (selectedJob && isConversationalJob(selectedJob) && !viewLockedRef.current) {
      setView("chat");
    }
  }, [selectedJob]);

  const chooseView = (next: "chat" | "terminal") => {
    viewLockedRef.current = true;
    setView(next);
  };

  if (!selectedJob) {
    return (
      <section className="run-agent-executor run-agent-executor-empty" aria-label="Agent 执行器">
        <div>
          <strong>尚未启动 Agent</strong>
          <p>从右侧控制区为当前节点启动 Agent。</p>
        </div>
      </section>
    );
  }

  const sessionState = sessionStateByJob[selectedJob.id];
  const active = selectedJob.status === "QUEUED" || selectedJob.status === "RUNNING";
  const writable = Boolean(
    selectedJob.mode === "interactive" && active && sessionState?.writable,
  );
  const viewportOutput = agentViewportOutput(
    selectedJob.id,
    persistedOutput,
    liveOutputByJob,
  );
  const statusMessage = selectedJob.mode === "automatic"
    ? "自动模式执行记录为只读。"
    : active && !sessionState?.writable
      ? "正在等待本地执行器连接，当前为只读。"
      : sessionState?.persistenceLimited
        ? "本地执行器可交互，输出持久化能力受限。"
        : null;

  return (
    <section
      className={`run-agent-executor${fullScreen ? " run-agent-executor-full" : ""}`}
      aria-label="Agent 执行器"
    >
      <div className="run-agent-executor-body">
        <aside className="run-agent-roster" aria-label="Agent 名册">
          <div className="run-agent-roster-heading">
            <span>子智能体</span>
            <small>{jobs.length}</small>
          </div>
          <div className="run-agent-job-tabs" role="tablist" aria-label="Agents">
          {jobs.map((candidate, index) => {
              const identity = identities[index];
              const Icon = AGENT_ICONS[identity.icon];
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={candidate.id === selectedJob.id}
                  aria-label={`${candidate.id} ${candidate.provider} ${candidate.status} ${identity.displayName}`}
                  title={candidate.id}
                  className={candidate.id === selectedJob.id ? "is-active" : ""}
                  onClick={() => onSelectJob(candidate.id)}
                >
                  <span className="run-agent-avatar" data-testid="agent-icon" style={{ "--agent-color": identity.color } as CSSProperties}>
                    <Icon size={13} aria-hidden="true" />
                  </span>
                  <span className="run-agent-name" data-testid="agent-codename">{identity.displayName}</span>
                  <span className={`run-agent-status is-${candidate.status.toLowerCase()}`}>{agentStatusLabel(candidate.status)}</span>
                </button>
              );
            })}
          </div>
        </aside>
        <div className="run-agent-executor-main">
          <div className="run-agent-executor-toolbar">
            <div className="run-agent-executor-heading">
              <span className="eyebrow">Agent 执行器</span>
              <strong>{selectedJob.provider} · {shortJobId(selectedJob.id)}</strong>
              <span>{selectedJob.nodeId} · {agentStatusLabel(selectedJob.status)}</span>
            </div>
            <div className="run-agent-executor-actions">
              {conversational ? (
                <div className="agent-view-toggle">
                  <button
                    type="button"
                    className={view === "chat" ? "is-active" : ""}
                    onClick={() => chooseView("chat")}
                  >
                    聊天
                  </button>
                  <button
                    type="button"
                    className={view === "terminal" ? "is-active" : ""}
                    onClick={() => chooseView("terminal")}
                  >
                    终端
                  </button>
                </div>
              ) : null}
              {showFullScreenLink && !fullScreen ? (
                <a href={buildRunAgentExecutorHash(runId, selectedJob.id)}>全屏执行器</a>
              ) : null}
              {active ? (
                <button type="button" className="danger-button" onClick={() => onStop(selectedJob.id)}>
                  停止 Agent
                </button>
              ) : null}
            </div>
          </div>

          {statusMessage ? <p className="run-agent-executor-note">{statusMessage}</p> : null}
          {conversational && view === "chat" ? (
            <AgentChatView
              jobLabel={`${selectedJob.provider} · ${shortJobId(selectedJob.id)}`}
              messages={agentChatMessages(selectedJob.id, persistedOutput)}
              permissions={permissionsByJob?.[selectedJob.id] ?? []}
              disabled={selectedJob.status !== "AWAITING_INPUT"}
              onSend={(message) =>
                onContinueConversation
                  ? onContinueConversation(selectedJob.id, message)
                  : Promise.resolve()
              }
              onDecide={(requestId, decision) =>
                onDecidePermission
                  ? onDecidePermission(selectedJob.id, requestId, decision)
                  : Promise.resolve()
              }
            />
          ) : (
            <TerminalViewport
              ariaLabel={`Agent 执行器 ${selectedJob.id}`}
              resetKey={selectedJob.id}
              output={viewportOutput}
              writable={writable}
              onInput={writable ? (data) => onInput(selectedJob.id, data) : undefined}
              onInterrupt={writable ? () => onInterrupt(selectedJob.id) : undefined}
              onResize={(columns, rows) => onResize(selectedJob.id, columns, rows)}
            />
          )}
        </div>
      </div>
    </section>
  );
}
