export function RunDashboard() {
  return (
    <section id="runs" className="panel" aria-labelledby="runs-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Run</p>
          <h2 id="runs-title">Run Dashboard</h2>
        </div>
        <span className="status-pill status-blocked">blocked</span>
      </div>
      <p className="body-copy">
        展示 Runtime projection 中的 run 状态、允许操作和关键 evidence；所有动作必须等待 Runtime allowedActions。
      </p>
      <dl className="facts">
        <div>
          <dt>当前 Run 状态</dt>
          <dd>waiting_for_gate</dd>
        </div>
        <div>
          <dt>允许操作</dt>
          <dd>Runtime API 已建立纵向路径，前端不本地推进状态。</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>计划、测试输出、人工审批记录将由 Runtime 提供。</dd>
        </div>
      </dl>
      <button className="quiet-button" disabled>
        等待 Runtime allowedActions
      </button>
    </section>
  );
}
