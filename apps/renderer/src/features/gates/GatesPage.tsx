export function GatesPage() {
  return (
    <section id="gates" className="panel" aria-labelledby="gates-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Quality Gates</p>
          <h2 id="gates-title">Gates</h2>
        </div>
        <span className="status-pill status-blocked">waiting</span>
      </div>
      <p className="body-copy">
        gate 状态来自 Runtime projection；前端不提供本地通过、跳过或重置 gate 的状态变更。
      </p>
      <div className="gate-stack">
        <span>测试 gate：等待 evidence</span>
        <span>安全 gate：等待审批结果</span>
        <span>发布 gate：未开放 allowed action</span>
      </div>
      <button className="quiet-button" disabled>
        等待 Runtime allowedActions
      </button>
    </section>
  );
}
