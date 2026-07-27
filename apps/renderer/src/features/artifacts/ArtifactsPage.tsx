export function ArtifactsPage() {
  return (
    <section id="artifacts" className="panel" aria-labelledby="artifacts-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Evidence</p>
          <h2 id="artifacts-title">Artifacts</h2>
        </div>
        <span className="status-pill">index pending</span>
      </div>
      <p className="body-copy">
        证据与产物索引暂以只读摘要呈现，包括测试日志、构建输出、计划文件和审计记录。
      </p>
      <dl className="facts">
        <div>
          <dt>最近 evidence</dt>
          <dd>renderer-test.red.log</dd>
        </div>
        <div>
          <dt>保留策略</dt>
          <dd>由 Runtime artifact manifest 决定。</dd>
        </div>
      </dl>
    </section>
  );
}
