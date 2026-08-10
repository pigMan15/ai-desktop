import type { RunProjection } from "@workflow-platform/contracts";
import type { NodeArtifactScan } from "../../app/runtimeClient";

export type ArtifactScanFeedbackState =
  | { phase: "idle" }
  | { phase: "scanning"; nodeId: string }
  | { phase: "success"; nodeId: string; result: NodeArtifactScan }
  | { phase: "error"; nodeId: string; message: string };

export type RunArtifactScanFeedbackProps = {
  state: ArtifactScanFeedbackState;
  nodeName: string;
  canComplete: boolean;
  blockers: RunProjection["blockingReasons"];
  artifactsHref: string;
};

export function RunArtifactScanFeedback({
  state,
  nodeName,
  canComplete,
  blockers,
  artifactsHref,
}: RunArtifactScanFeedbackProps) {
  if (state.phase === "idle") return null;

  if (state.phase === "scanning") {
    return (
      <section className="run-artifact-scan-feedback" role="status" aria-label="产物检查结果">
        正在扫描声明的产物...
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section
        className="run-artifact-scan-feedback is-error"
        role="status"
        aria-label="产物检查结果"
      >
        <strong>产物扫描失败</strong>
        <p>{state.message}</p>
      </section>
    );
  }

  const { registered, unchanged, missing, invalid } = state.result;
  const satisfied = registered.length + unchanged.length;
  const total = satisfied + missing.length + invalid.length;
  const ready = missing.length === 0 && invalid.length === 0 && canComplete;

  return (
    <section
      className={`run-artifact-scan-feedback ${ready ? "is-ready" : "is-blocked"}`}
      role="status"
      aria-label="产物检查结果"
    >
      <div className="run-artifact-scan-summary">
        <div>
          <span>产物检查结果</span>
          <strong>已满足 {satisfied}/{total}</strong>
          <small>{nodeName}</small>
        </div>
        <a href={artifactsHref}>查看全部产物</a>
      </div>

      <dl className="run-artifact-scan-counts">
        <div><dt>本次提交</dt><dd>{registered.length}</dd></div>
        <div><dt>已存在</dt><dd>{unchanged.length}</dd></div>
        <div><dt>缺失</dt><dd>{missing.length}</dd></div>
        <div><dt>无效</dt><dd>{invalid.length}</dd></div>
      </dl>

      {missing.length > 0 ? <p>缺失：{missing.join(", ")}</p> : null}
      {invalid.map((item) => (
        <p key={`${item.artifactSpecId}:${item.reason}`}>
          {item.artifactSpecId}：{item.reason}
        </p>
      ))}

      <strong>
        {ready ? "产物要求已满足，可以完成当前节点" : "暂不能进入下一步"}
      </strong>
      {!ready && blockers.length > 0 ? (
        <ul>
          {blockers.map((blocker) => (
            <li key={`${blocker.code}:${blocker.nodeId ?? "run"}`}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
