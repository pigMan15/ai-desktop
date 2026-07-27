export function SettingsPage() {
  return (
    <section id="settings" className="panel" aria-labelledby="settings-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Configuration</p>
          <h2 id="settings-title">Settings</h2>
        </div>
        <span className="status-pill">只读</span>
      </div>
      <p className="body-copy">
        设置项当前仅展示目标配置面，包括 Runtime endpoint、审批策略、evidence 保留和通知偏好。
      </p>
      <dl className="facts">
        <div>
          <dt>Runtime endpoint</dt>
          <dd>未配置</dd>
        </div>
        <div>
          <dt>审批策略</dt>
          <dd>高风险操作需要人工确认。</dd>
        </div>
      </dl>
    </section>
  );
}
