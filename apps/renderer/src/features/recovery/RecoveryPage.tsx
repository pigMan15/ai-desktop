import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = { state: RuntimeWorkbenchState | null };

export function RecoveryPage({ state }: Props) {
  const runId = state?.projection.runId ?? "加载中";

  return (
    <section id="recovery" className="panel" aria-labelledby="recovery-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Recovery</p>
          <h2 id="recovery-title">Recovery</h2>
        </div>
        <span className="status-pill">只读入口</span>
      </div>
      <p className="body-copy">
        恢复建议需要后端快照和审计记录；此处仅展示当前 Run 的 projection rebuild 入口。
      </p>
      <ul className="compact-list">
        <li>Run：{runId}</li>
        <li>可从 Runtime 快照重建 projection：{runId}</li>
        <li>建议：等待 Runtime 提供恢复计划，Renderer 不本地修复状态。</li>
      </ul>
    </section>
  );
}
