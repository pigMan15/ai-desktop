import { useState } from "react";

import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = {
  state: RuntimeWorkbenchState | null;
  onDecide?: (
    nodeId: string,
    decision: "approved" | "rejected" | "deferred",
    comment: string,
  ) => void;
};

const approvalStatusText: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  deferred: "已暂缓",
};

export function ApprovalInbox({ state, onDecide }: Props) {
  const approvals = Array.isArray(state?.approvals) ? state.approvals : [];
  const [comment, setComment] = useState("");
  const projection = state?.projection;
  const nodeId = projection?.currentNodeIds.find(
    (candidate) => projection.nodeStates[candidate] === "AWAITING_APPROVAL",
  );
  const canDecide = (eventType: "HUMAN_APPROVED" | "HUMAN_REJECTED" | "HUMAN_DEFERRED") =>
    Boolean(nodeId && projection?.allowedActions.some(
      (action) => action.nodeId === nodeId && action.eventType === eventType,
    ));

  return (
    <section id="approvals" className="panel" aria-labelledby="approvals-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Human Review</p>
          <h2 id="approvals-title">审批中心</h2>
        </div>
        <span className="status-pill status-watch">
          {approvals.length > 0 ? "待处理" : "加载中"}
        </span>
      </div>
      <p className="body-copy">
        审批项需要 Runtime allowedActions 才能处理；Renderer 只展示请求来源、状态、备注和阻塞范围。
      </p>
      <ul className="compact-list">
        {approvals.map((approval) => (
          <li key={approval.id}>
            {approval.id}：{approvalStatusText[approval.status] ?? approval.status}
            {approval.comment ? `；备注：${approval.comment}` : "；暂无备注"}
            {approval.invalidatedAt ? `；已失效：${approval.invalidationReason ?? "Artifact 已变更"}` : ""}
            {approval.artifactHashes?.length ? `；绑定产物 ${approval.artifactHashes.length} 个哈希` : ""}
          </li>
        ))}
        {approvals.length === 0 ? <li>等待 Runtime 审批队列。</li> : null}
      </ul>
      {nodeId ? (
        <div className="form-grid">
          <label>
            审批评论
            <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} />
          </label>
          <div className="button-row">
            <button
              className="quiet-button"
              disabled={!canDecide("HUMAN_APPROVED")}
              onClick={() => onDecide?.(nodeId, "approved", comment.trim())}
            >
              批准
            </button>
            <button
              className="quiet-button"
              disabled={!canDecide("HUMAN_REJECTED")}
              onClick={() => onDecide?.(nodeId, "rejected", comment.trim())}
            >
              拒绝
            </button>
            <button
              className="quiet-button"
              disabled={!canDecide("HUMAN_DEFERRED")}
              onClick={() => onDecide?.(nodeId, "deferred", comment.trim())}
            >
              暂缓审批
            </button>
          </div>
        </div>
      ) : (
        <p className="body-copy">当前没有可由 Runtime 授权处理的审批节点。</p>
      )}
    </section>
  );
}
