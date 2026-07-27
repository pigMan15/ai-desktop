export function ApprovalInbox() {
  return (
    <section id="approvals" className="panel" aria-labelledby="approvals-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Human Review</p>
          <h2 id="approvals-title">Approval Inbox</h2>
        </div>
        <span className="status-pill status-watch">待处理</span>
      </div>
      <p className="body-copy">
        审批项需要 Runtime allowedActions 才能处理；renderer 只展示请求来源、风险和阻塞范围。
      </p>
      <ul className="compact-list">
        <li>请求：扩大文件写入范围；风险：影响非 Task 11 模块。</li>
        <li>阻塞：当前 run 无法继续 gate 校验。</li>
      </ul>
      <button className="quiet-button" disabled>
        等待 Runtime allowedActions
      </button>
    </section>
  );
}
