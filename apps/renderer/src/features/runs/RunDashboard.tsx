import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = {
  state: RuntimeWorkbenchState | null;
  onStartNode?: () => void;
  onSubmitArtifact?: () => void;
  onApprove?: () => void;
  onPassGate?: () => void;
};

export function RunDashboard({ state, onStartNode, onSubmitArtifact, onApprove, onPassGate }: Props) {
  const projection = state?.projection;
  const nodeId = projection?.currentNodeIds[0];
  const nodeState = nodeId ? projection.nodeStates[nodeId] : undefined;
  const blockingReason = projection?.blockingReasons[0];
  const hasRun = Boolean(state?.connection === "connected" && projection?.runId);
  const canSubmitArtifact =
    hasRun && (projection?.allowedActions.some((action) => action.label === "提交 Artifact") ?? true);

  return (
    <section id="runs" className="panel" aria-labelledby="runs-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Run</p>
          <h2 id="runs-title">Run Dashboard</h2>
        </div>
        <span className="status-pill status-blocked">{projection?.status ?? "加载中"}</span>
      </div>
      <p className="body-copy">
        展示 Runtime projection 中的 run 状态、节点状态、阻塞原因和允许操作；所有动作必须等待 Runtime allowedActions。
      </p>
      <dl className="facts">
        <div>
          <dt>当前 Run 状态</dt>
          <dd>{projection?.status ?? "加载中"}</dd>
        </div>
        <div>
          <dt>当前节点状态</dt>
          <dd>{nodeState ?? "加载中"}</dd>
        </div>
        <div>
          <dt>阻塞原因</dt>
          <dd>
            {blockingReason
              ? `${blockingReason.code}：${blockingReason.message}`
              : "暂无阻塞原因"}
          </dd>
        </div>
      </dl>
      <ul className="compact-list" aria-label="Runtime Timeline">
        {(state?.timeline ?? []).map((event) => (
          <li key={event.id}>
            {event.type}
            {event.nodeId ? `：${event.nodeId}` : ""}
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button className="quiet-button" disabled={!hasRun} onClick={onStartNode}>
          启动节点
        </button>
        <button className="quiet-button" disabled={!canSubmitArtifact} onClick={onSubmitArtifact}>
          提交 Artifact
        </button>
        <button className="quiet-button" disabled={!hasRun} onClick={onApprove}>
          人工批准
        </button>
        <button className="quiet-button" disabled={!hasRun} onClick={onPassGate}>
          通过 Gate
        </button>
      </div>
    </section>
  );
}
