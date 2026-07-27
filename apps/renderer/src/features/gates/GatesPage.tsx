import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = { state: RuntimeWorkbenchState | null };

export function GatesPage({ state }: Props) {
  const gates = state?.gates ?? [];

  return (
    <section id="gates" className="panel" aria-labelledby="gates-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Quality Gates</p>
          <h2 id="gates-title">Gates</h2>
        </div>
        <span className="status-pill status-blocked">{gates[0]?.status ?? "加载中"}</span>
      </div>
      <p className="body-copy">
        gate 状态来自 Runtime projection；前端不提供本地通过、跳过或重置 gate 的状态变更。
      </p>
      <div className="gate-stack">
        {gates.map((gate) => (
          <span key={gate.id}>
            {gate.id}：{gate.status}；evidence：{gate.evidence.join(", ") || "无"}
          </span>
        ))}
        {gates.length === 0 ? <span>等待 Runtime gate 状态。</span> : null}
      </div>
      <button className="quiet-button" disabled>
        等待 Runtime allowedActions
      </button>
    </section>
  );
}
