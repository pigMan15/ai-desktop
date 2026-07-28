import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = { state: RuntimeWorkbenchState | null };

export function ArtifactsPage({ state }: Props) {
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];

  return (
    <section id="artifacts" className="panel" aria-labelledby="artifacts-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Evidence</p>
          <h2 id="artifacts-title">Artifacts</h2>
        </div>
        <span className="status-pill">{artifacts.length > 0 ? "已索引" : "加载中"}</span>
      </div>
      <p className="body-copy">
        证据与产物索引来自 Runtime artifact guard，包括安全路径、内容哈希、测试日志和审计记录。
      </p>
      <dl className="facts">
        {artifacts.map((artifact) => (
          <div key={artifact.id}>
            <dt>{artifact.type}</dt>
            <dd>
              <span>{artifact.uri}</span>
              <br />
              <span>{artifact.contentHash}</span>
            </dd>
          </div>
        ))}
        {artifacts.length === 0 ? (
          <div>
            <dt>产物</dt>
            <dd>等待 Runtime artifact manifest。</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
