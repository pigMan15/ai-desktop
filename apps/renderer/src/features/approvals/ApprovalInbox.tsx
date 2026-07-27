import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = { state: RuntimeWorkbenchState | null };

const approvalStatusText: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
};

export function ApprovalInbox({ state }: Props) {
  const approvals = state?.approvals ?? [];

  return (
    <section id="approvals" className="panel" aria-labelledby="approvals-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Human Review</p>
          <h2 id="approvals-title">Approval Inbox</h2>
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
          </li>
        ))}
        {approvals.length === 0 ? <li>等待 Runtime 审批队列。</li> : null}
      </ul>
      <button className="quiet-button" disabled>
        等待 Runtime allowedActions
      </button>
    </section>
  );
}
