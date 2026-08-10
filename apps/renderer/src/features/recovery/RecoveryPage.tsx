import { Fragment, useEffect, useState } from "react";

import { RuntimeClientError, type RecoveryDiagnostics, type RuntimeWorkbenchState } from "../../app/runtimeClient";
import { buildRunDetailHash, type RunContext } from "../../app/routes";

type Props = {
  context?: RunContext;
  client?: {
    getRecoveryDiagnostics: (projectId: string, runId: string, signal?: AbortSignal) => Promise<RecoveryDiagnostics>;
    cleanupOrphanAgentJobs?: (projectId: string, runId: string, now: string, signal?: AbortSignal) => Promise<{ cleanedJobIds: string[] }>;
    cleanupOrphanTerminalSessions?: (projectId: string, runId: string, now: string, signal?: AbortSignal) => Promise<{ cleanedSessionIds: string[] }>;
    rebuildProjection?: (projectId: string, runId: string, now: string, signal?: AbortSignal) => Promise<unknown>;
  };
  state: RuntimeWorkbenchState | null;
  onRebuild?: () => void;
  diagnostics?: RecoveryDiagnostics | null;
  onCleanupOrphans?: () => void;
  onCleanupTerminalSessions?: () => void;
  onResumeAgentCheckpoint?: (checkpointId: string) => void;
  onDiscardAgentCheckpoint?: (checkpointId: string) => void;
  operationMessage?: string;
};

export function RecoveryPage({
  context,
  client,
  state,
  onRebuild,
  diagnostics: providedDiagnostics = null,
  onCleanupOrphans,
  onCleanupTerminalSessions,
  onResumeAgentCheckpoint,
  onDiscardAgentCheckpoint,
  operationMessage,
}: Props) {
  const [scopedDiagnostics, setScopedDiagnostics] = useState<RecoveryDiagnostics | null>(null);
  const [error, setError] = useState<RuntimeClientError | null>(null);
  const [scopedOperationMessage, setScopedOperationMessage] = useState("");
  const diagnostics = scopedDiagnostics ?? providedDiagnostics;
  const runId = context?.runId ?? state?.projection?.runId;
  const recoverableCheckpointIds = diagnostics?.recoverableAgentCheckpointIds ?? [];

  useEffect(() => {
    if (!context || !client) return;
    const controller = new AbortController();
    setError(null);
    void client.getRecoveryDiagnostics(context.projectId, context.runId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setScopedDiagnostics(value); })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
      });
    return () => controller.abort();
  }, [client, context?.projectId, context?.runId]);

  async function cleanupScopedAgents() {
    if (!context || !client?.cleanupOrphanAgentJobs) return;
    try {
      const result = await client.cleanupOrphanAgentJobs(context.projectId, context.runId, new Date().toISOString());
      setScopedDiagnostics(await client.getRecoveryDiagnostics(context.projectId, context.runId));
      setScopedOperationMessage(`已清理遗留 Agent：${result.cleanedJobIds.length} 个`);
    } catch (failure) {
      setError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
    }
  }

  async function cleanupScopedTerminals() {
    if (!context || !client?.cleanupOrphanTerminalSessions) return;
    try {
      const result = await client.cleanupOrphanTerminalSessions(context.projectId, context.runId, new Date().toISOString());
      setScopedDiagnostics(await client.getRecoveryDiagnostics(context.projectId, context.runId));
      setScopedOperationMessage(`已清理遗留终端：${result.cleanedSessionIds.length} 个`);
    } catch (failure) {
      setError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
    }
  }

  async function rebuildScopedProjection() {
    if (!context || !client?.rebuildProjection) return;
    try {
      await client.rebuildProjection(context.projectId, context.runId, new Date().toISOString());
      setScopedDiagnostics(await client.getRecoveryDiagnostics(context.projectId, context.runId));
      setScopedOperationMessage(`投影已重建：${context.runId}`);
    } catch (failure) {
      setError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
    }
  }

  return (
    <section id="recovery" className="panel page-workspace page-recovery" aria-labelledby="recovery-title">
      {context ? <div className="button-row"><a className="quiet-button" href={buildRunDetailHash(context.runId)}>返回 Run</a></div> : null}
      {error ? <p role="alert" className="body-copy">{error.message}</p> : null}
      <div className="panel-heading">
        <div>
          <p className="section-kicker">恢复</p>
          <h2 id="recovery-title">恢复</h2>
        </div>
        <span className="status-pill">{runId ? "可执行恢复" : "等待 Run"}</span>
      </div>
      <p className="body-copy">
        从 Runtime 的持久化事件重建当前 Run 投影。该操作不会在 Renderer 本地篡改状态。
      </p>
      <ul className="compact-list">
        <li>Run：{runId ?? "尚未创建 Run"}</li>
        <li>重建后会重新加载节点、产物、审批、门禁和 Agent 状态。</li>
        {diagnostics ? (
          <>
            <li>事件数：{diagnostics.eventCount}</li>
            <li>投影状态：{diagnostics.projectionStatus}</li>
            <li>
              遗留 Agent：
              {diagnostics.orphanAgentJobIds.length > 0
                ? diagnostics.orphanAgentJobIds.join("、")
                : "无"}
            </li>
            <li>
              待恢复终端：
              {diagnostics.orphanTerminalSessionIds.length > 0
                ? diagnostics.orphanTerminalSessionIds.join("、")
                : "无"}
            </li>
            <li>
              可恢复 Agent checkpoint：
              {recoverableCheckpointIds.length > 0
                ? recoverableCheckpointIds.join("、")
                : "无"}
            </li>
            {diagnostics.workspaceLease ? (
              <li>
                工作区租约：{diagnostics.workspaceLease.workspacePath} · {diagnostics.workspaceLease.status}
                <small>最近验证 {diagnostics.workspaceLease.lastVerifiedAt}</small>
              </li>
            ) : null}
          </>
        ) : null}
      </ul>
      <div className="button-row">
        <button className="quiet-button" disabled={!runId} onClick={context ? () => void rebuildScopedProjection() : onRebuild}>
          重建投影
        </button>
        {diagnostics && diagnostics.orphanAgentJobIds.length > 0 ? (
          <button className="quiet-button" onClick={context ? () => void cleanupScopedAgents() : onCleanupOrphans}>
            清理遗留 Agent
          </button>
        ) : null}
        {diagnostics && diagnostics.orphanTerminalSessionIds.length > 0 ? (
          <button className="quiet-button" onClick={context ? () => void cleanupScopedTerminals() : onCleanupTerminalSessions}>
            清理遗留终端
          </button>
        ) : null}
        {recoverableCheckpointIds.map((checkpointId) => (
          <Fragment key={checkpointId}>
            <button
              className="quiet-button"
              onClick={() => onResumeAgentCheckpoint?.(checkpointId)}
            >
              恢复 Agent checkpoint
            </button>
            <button
              className="quiet-button"
              onClick={() => onDiscardAgentCheckpoint?.(checkpointId)}
            >
              放弃 Agent checkpoint
            </button>
          </Fragment>
        ))}
      </div>
      {scopedOperationMessage || operationMessage ? <p className="body-copy" role="status">{scopedOperationMessage || operationMessage}</p> : null}
    </section>
  );
}
