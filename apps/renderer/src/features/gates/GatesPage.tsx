import { useEffect, useState } from "react";

import { RuntimeClientError, type RuntimeWorkbenchState } from "../../app/runtimeClient";
import { buildRunDetailHash, type RunContext } from "../../app/routes";

type Props = {
  context?: RunContext;
  client?: {
    getProjectRunOverview: (projectId: string, runId: string, signal?: AbortSignal) => Promise<{ projection: NonNullable<RuntimeWorkbenchState["projection"]> }>;
    listGates: (projectId: string, runId: string, signal?: AbortSignal) => Promise<RuntimeWorkbenchState["gates"]>;
    retryGate?: (projectId: string, runId: string, nodeId: string, expectedRevision: string, now: string) => Promise<unknown>;
    submitGate?: (projectId: string, runId: string, nodeId: string, gateId: string, status: "passed" | "failed" | "waived", evidence: string[], waiverReason: string | null, expectedRevision: string, now: string) => Promise<unknown>;
  };
  state: RuntimeWorkbenchState | null;
  onRetryGate?: (nodeId: string) => void;
  onDownloadGateReport?: () => void;
  onWaiveGate?: (nodeId: string, gateId: string, waiverReason: string) => void;
};

export function GatesPage({ context, client, state, onRetryGate, onDownloadGateReport, onWaiveGate }: Props) {
  const [waiverReasons, setWaiverReasons] = useState<Record<string, string>>({});
  const [scopedGates, setScopedGates] = useState<RuntimeWorkbenchState["gates"] | null>(null);
  const [scopedProjection, setScopedProjection] = useState<RuntimeWorkbenchState["projection"]>(null);
  const [scopedError, setScopedError] = useState<RuntimeClientError | null>(null);
  const gates = scopedGates ?? (Array.isArray(state?.gates) ? state.gates : []);
  const projection = scopedProjection ?? state?.projection;
  const allowedActions = projection?.allowedActions ?? [];
  const blockingReasons = projection?.blockingReasons ?? [];

  useEffect(() => {
    if (!context || !client) return;
    const controller = new AbortController();
    setScopedGates(null);
    setScopedProjection(null);
    setScopedError(null);
    void Promise.all([
      client.getProjectRunOverview(context.projectId, context.runId, controller.signal),
      client.listGates(context.projectId, context.runId, controller.signal),
    ]).then(([overview, records]) => {
      if (!controller.signal.aborted) { setScopedProjection(overview.projection); setScopedGates(records); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setScopedError(error instanceof RuntimeClientError ? error : new RuntimeClientError(null, "RUNTIME_ERROR", error instanceof Error ? error.message : String(error), undefined, null));
    });
    return () => controller.abort();
  }, [client, context?.projectId, context?.runId]);
  const retryableNodeIds = new Set(
    allowedActions
      .filter((action) => action.eventType === "NODE_RETRIED" && action.nodeId)
      .map((action) => action.nodeId),
  );
  const waiverNodeIds = new Set(
    allowedActions
      .filter((action) => action.eventType === "GATE_WAIVED" && action.nodeId)
      .map((action) => action.nodeId),
  );

  async function refreshScoped() {
    if (!context || !client) return;
    const [overview, records] = await Promise.all([
      client.getProjectRunOverview(context.projectId, context.runId),
      client.listGates(context.projectId, context.runId),
    ]);
    setScopedProjection(overview.projection);
    setScopedGates(records);
  }

  async function retryScopedGate(nodeId: string) {
    if (!context || !client?.retryGate || !projection) return;
    await client.retryGate(context.projectId, context.runId, nodeId, projection.revision, new Date().toISOString());
    await refreshScoped();
  }

  async function waiveScopedGate(gate: RuntimeWorkbenchState["gates"][number], reason: string) {
    if (!context || !client?.submitGate || !projection || !gate.nodeId || !gate.gateId) return;
    await client.submitGate(context.projectId, context.runId, gate.nodeId, gate.gateId, "waived", gate.evidence, reason, projection.revision, new Date().toISOString());
    await refreshScoped();
  }

  return (
    <section id="gates" className="panel page-workspace page-gates" aria-labelledby="gates-title">
      {context ? <div className="button-row"><a className="quiet-button" href={buildRunDetailHash(context.runId)}>返回 Run</a></div> : null}
      {scopedError ? <p role="alert" className="body-copy">{scopedError.message}</p> : null}
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Quality Gates</p>
          <h2 id="gates-title">门禁</h2>
        </div>
        <span className="status-pill status-blocked">{gates[0]?.status ?? "等待结果"}</span>
      </div>
      <p className="body-copy">
        门禁结果由 Runtime 的受信执行者提交。通过、失败和豁免都会保留证据或授权理由，界面不在本地修改结果。
      </p>
      {gates.length > 0 && onDownloadGateReport ? (
        <div className="button-row">
          <button className="quiet-button" onClick={onDownloadGateReport}>
            下载 Gate 报告
          </button>
        </div>
      ) : null}
      {gates.length > 0 ? (
        <div className="gate-stack" aria-label="Gate 审查记录">
          {gates.map((gate) => {
            const reviewCount = gates.filter(
              (candidate) =>
                candidate.gateId === gate.gateId && candidate.nodeId === gate.nodeId,
            ).length;
            const gateBlockingReasons = blockingReasons.filter(
              (reason) => reason.nodeId === gate.nodeId,
            );
            const gateAllowedActions = allowedActions.filter(
              (action) => action.nodeId === gate.nodeId || action.nodeId === undefined,
            );
            const waiverReason = waiverReasons[gate.id] ?? "";
            const isAutomaticGate =
              gate.actor?.id === "runtime-auto-gate" && gate.actor?.type === "system";
            const canWaive =
              Boolean(onWaiveGate || (context && client?.submitGate)) &&
              gate.status === "failed" &&
              Boolean(gate.nodeId) &&
              Boolean(gate.gateId) &&
              waiverNodeIds.has(gate.nodeId ?? "");

            return (
              <article key={gate.id} className="gate-record">
                <div className="panel-heading">
                  <strong>{gate.gateId ?? gate.id}</strong>
                  <span className="status-pill">{gate.status}</span>
                </div>
                <dl className="facts">
                  <div>
                    <dt>节点</dt>
                    <dd>{gate.nodeId ?? "未关联节点"}</dd>
                  </div>
                  <div>
                    <dt>执行者</dt>
                    <dd>{gate.actor?.id ?? "Runtime 未返回"}</dd>
                  </div>
                  <div>
                    <dt>验证方式</dt>
                    <dd>{isAutomaticGate ? "自动 Gate" : "人工 Verifier"}</dd>
                  </div>
                  <div>
                    <dt>提交时间</dt>
                    <dd>{gate.createdAt ?? "Runtime 未返回"}</dd>
                  </div>
                </dl>
                <p className="body-copy">同一 Gate 已记录 {reviewCount} 次审查</p>
                <p className="body-copy">
                  证据：{gate.evidence.length > 0 ? gate.evidence.join("；") : "无证据"}
                </p>
                {gate.waiverReason ? (
                  <p className="body-copy">豁免理由：{gate.waiverReason}</p>
                ) : null}
                {gate.failureReason ? (
                  <p className="body-copy">失败原因：{gate.failureReason}</p>
                ) : null}
                {gate.invalidatedAt ? (
                  <p className="body-copy">该决策已失效：{gate.invalidationReason ?? "Artifact 已变更"}</p>
                ) : null}
                {gate.artifactHashes?.length ? (
                  <p className="body-copy">绑定 Artifact 哈希：{gate.artifactHashes.join("；")}</p>
                ) : null}
                <p className="body-copy">
                  当前阻塞：
                  {gateBlockingReasons.length > 0
                    ? gateBlockingReasons.map((reason) => reason.message).join("；")
                    : "无"}
                </p>
                <p className="body-copy">
                  下一步允许的操作：
                  {gateAllowedActions.length > 0
                    ? gateAllowedActions.map((action) => action.label).join("；")
                    : "无"}
                </p>
                {gate.status === "failed" && gate.nodeId && retryableNodeIds.has(gate.nodeId) ? (
                  <button className="quiet-button" onClick={() => context ? void retryScopedGate(gate.nodeId!) : onRetryGate?.(gate.nodeId!)}>
                    重试 Gate
                  </button>
                ) : null}
                {canWaive ? (
                  <div className="form-grid">
                    <label className="form-wide">
                      {`Gate 豁免理由：${gate.gateId}`}
                      <textarea
                        value={waiverReason}
                        onChange={(event) =>
                          setWaiverReasons((current) => ({
                            ...current,
                            [gate.id]: event.target.value,
                          }))
                        }
                        placeholder="说明授权人、风险影响和临时豁免原因"
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="quiet-button"
                        disabled={!waiverReason.trim()}
                        onClick={() => context
                          ? void waiveScopedGate(gate, waiverReason.trim())
                          : onWaiveGate?.(gate.nodeId!, gate.gateId!, waiverReason.trim())}
                      >
                        提交 Gate 豁免
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="body-copy">当前 Run 还没有 Gate 审查记录。</p>
      )}
    </section>
  );
}
