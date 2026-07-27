export function RecoveryPage() {
  return (
    <section id="recovery" className="panel" aria-labelledby="recovery-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Recovery</p>
          <h2 id="recovery-title">Recovery</h2>
        </div>
        <span className="status-pill">draft</span>
      </div>
      <p className="body-copy">
        恢复建议需要后端快照和审计记录；此处仅展示可恢复点、失败阶段和人工介入理由。
      </p>
      <ul className="compact-list">
        <li>恢复点：进入 Review Gate 前。</li>
        <li>失败阶段：缺少 allowedActions 响应。</li>
        <li>建议：等待 Runtime 提供恢复计划。</li>
      </ul>
    </section>
  );
}
