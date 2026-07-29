import { useState } from "react";

import type { AuditRecord } from "../../app/runtimeClient";

type Props = {
  records: AuditRecord[];
  onFilter: (action: string) => void;
};

export function AuditPage({ records, onFilter }: Props) {
  const [action, setAction] = useState("");

  return (
    <section id="audit" className="panel" aria-labelledby="audit-title">
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
        <button className="quiet-button" onClick={() => onFilter(action.trim())}>
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
