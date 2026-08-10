import { useEffect, useState } from "react";

import { RuntimeClientError, type AuditRecord } from "../../app/runtimeClient";
import { buildRunDetailHash, type RunContext } from "../../app/routes";

type Props = {
  context?: RunContext;
  client?: { listRunAuditRecords: (projectId: string, runId: string, action?: string, signal?: AbortSignal) => Promise<AuditRecord[]> };
  records?: AuditRecord[];
  onFilter?: (action: string) => void;
};

export function AuditPage({ context, client, records: providedRecords = [], onFilter }: Props) {
  const [action, setAction] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [scopedRecords, setScopedRecords] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState<RuntimeClientError | null>(null);
  const records = scopedRecords ?? providedRecords;

  useEffect(() => {
    if (!context || !client) return;
    const controller = new AbortController();
    setError(null);
    void client.listRunAuditRecords(context.projectId, context.runId, appliedAction, controller.signal)
      .then((items) => { if (!controller.signal.aborted) setScopedRecords(items); })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
      });
    return () => controller.abort();
  }, [appliedAction, client, context?.projectId, context?.runId]);

  function applyFilter() {
    const next = action.trim();
    if (context && client) setAppliedAction(next);
    else onFilter?.(next);
  }

  return (
    <section id="audit" className="panel page-workspace page-audit" aria-labelledby="audit-title">
      {context ? <div className="button-row"><a className="quiet-button" href={buildRunDetailHash(context.runId)}>返回 Run</a></div> : null}
      {error ? <p role="alert" className="body-copy">{error.message}</p> : null}
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Governance</p>
          <h2 id="audit-title">审计记录</h2>
        </div>
        <span className="status-pill">{records.length} 条记录</span>
      </div>
      <div className="form-grid">
        <label>
          审计动作筛选
          <input value={action} onChange={(event) => setAction(event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button className="quiet-button" onClick={applyFilter}>
          查询审计
        </button>
      </div>
      <div className="gate-stack" aria-label="不可篡改审计记录">
        {records.map((record) => (
          <article key={record.id} className="gate-record">
            <div className="panel-heading">
              <strong>{record.action}</strong>
              <span className="status-pill">{record.createdAt}</span>
            </div>
            <dl className="facts">
              <div>
                <dt>操作者</dt>
                <dd>{record.actor.id}</dd>
              </div>
              <div>
                <dt>资源</dt>
                <dd>{record.resource}</dd>
              </div>
              <div>
                <dt>记录哈希</dt>
                <dd>{record.recordHash}</dd>
              </div>
            </dl>
          </article>
        ))}
        {records.length === 0 ? <p className="body-copy">没有符合条件的审计记录。</p> : null}
      </div>
    </section>
  );
}
