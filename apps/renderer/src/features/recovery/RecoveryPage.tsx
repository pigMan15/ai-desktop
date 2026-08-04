import { Fragment } from "react";

import type { RecoveryDiagnostics, RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = {
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
  state,
  onRebuild,
  diagnostics = null,
  onCleanupOrphans,
  onCleanupTerminalSessions,
  onResumeAgentCheckpoint,
  onDiscardAgentCheckpoint,
  operationMessage,
}: Props) {
  const runId = state?.projection?.runId;
  const recoverableCheckpointIds = diagnostics?.recoverableAgentCheckpointIds ?? [];

  return (
    <section id="recovery" className="panel page-workspace page-recovery" aria-labelledby="recovery-title">
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
          </>
        ) : null}
      </ul>
      <div className="button-row">
        <button className="quiet-button" disabled={!runId} onClick={onRebuild}>
          重建投影
        </button>
        {diagnostics && diagnostics.orphanAgentJobIds.length > 0 ? (
          <button className="quiet-button" onClick={onCleanupOrphans}>
            清理遗留 Agent
          </button>
        ) : null}
        {diagnostics && diagnostics.orphanTerminalSessionIds.length > 0 ? (
          <button className="quiet-button" onClick={onCleanupTerminalSessions}>
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
      {operationMessage ? <p className="body-copy" role="status">{operationMessage}</p> : null}
    </section>
  );
}
