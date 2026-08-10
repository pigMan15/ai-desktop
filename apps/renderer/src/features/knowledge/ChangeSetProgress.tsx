import { useEffect, useRef, useState } from "react";

import type { KnowledgeClient } from "./knowledgeClient";

type Props = {
  client: KnowledgeClient;
  projectId: string;
  runId: string;
  changeSetId: string;
  status: "GENERATING" | "APPLYING";
};

type LogEntry = { sequence: number; kind: string; text: string };

export function ChangeSetProgress({ client, projectId, runId, changeSetId, status }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries([]);
    setElapsed(0);
  }, [changeSetId, status]);

  useEffect(() => {
    if (!projectId || !runId || !changeSetId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const output = await client.listChangeSetOutput(projectId, runId, changeSetId, 0);
        if (cancelled) return;
        const items = output.items.map((item) => {
          const payload = item.payload as { text?: unknown };
          return {
            sequence: item.sequence,
            kind: item.kind,
            text: typeof payload.text === "string" ? payload.text : JSON.stringify(item.payload),
          };
        });
        setEntries(items);
      } catch {
        // 输出暂不可用时保持现状
      }
      setElapsed((seconds) => seconds + 1);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, projectId, runId, changeSetId]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const label = status === "APPLYING" ? "变更集应用中" : "变更集生成中";
  return (
    <section className="knowledge-section">
      <div className="knowledge-detail-header" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{label}</h3>
        <span className="knowledge-badge knowledge-badge--rules-pending">{status}</span>
      </div>
      <div className="knowledge-actions" style={{ marginBottom: 10 }}>
        <span className="knowledge-meta">已运行 {elapsed}s</span>
        <span className="knowledge-meta">输出 {entries.length} 条</span>
      </div>
      <div className="knowledge-job-progress" aria-hidden="true">
        <span />
      </div>
      <div
        ref={logRef}
        className="knowledge-diff knowledge-job-log"
        role="log"
        aria-label={`${label}输出`}
      >
        {entries.length === 0 ? (
          <span className="knowledge-log-line knowledge-log-line--muted">（等待 Agent 输出…）</span>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.sequence}
              className={`knowledge-log-line knowledge-log-line--${entry.kind}`}
            >
              {entry.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
