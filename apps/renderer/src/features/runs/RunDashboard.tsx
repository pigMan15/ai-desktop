import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = { state: RuntimeWorkbenchState | null };

export function RunDashboard({ state }: Props) {
  const projection = state?.projection;
  const nodeId = projection?.currentNodeIds[0];
  const nodeState = nodeId ? projection.nodeStates[nodeId] : undefined;
  const blockingReason = projection?.blockingReasons[0];
  const canSubmitArtifact =
    projection?.allowedActions.some((action) => action.label === "提交 Artifact") ?? false;

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
      <button className="quiet-button" disabled={!canSubmitArtifact}>
        提交 Artifact
      </button>
    </section>
  );
}
