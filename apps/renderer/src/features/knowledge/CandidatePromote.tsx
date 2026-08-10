import { useCallback, useEffect, useState } from "react";

import { RuntimeClientError, type KnowledgeClient } from "./knowledgeClient";

type Props = {
  client: KnowledgeClient;
  repositoryId: string;
  expectedRevision: string;
  onPromoted: () => void;
};

export function CandidatePromote({ client, repositoryId, expectedRevision, onPromoted }: Props) {
  const [items, setItems] = useState<Array<{ path: string; title: string; sizeBytes: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .listCandidateKnowledge(repositoryId)
      .then((value) => setItems(value.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [client, repositoryId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const defaultTarget = (path: string) => `main/${path.split("/").pop()}`;

  const promote = async (path: string) => {
    const targetPath = (targets[path] ?? defaultTarget(path)).trim();
    if (!targetPath) return;
    setPromoting(path);
    setError(null);
    setMessage(null);
    try {
      await client.promoteCandidateKnowledge(repositoryId, {
        path,
        targetPath,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        expectedRevision,
        now: new Date().toISOString(),
      });
      setEditing(null);
      setTargets((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setMessage(`已转正：${path} → ${targetPath}`);
      refresh();
      onPromoted();
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "转正失败");
    } finally {
      setPromoting(null);
    }
  };

  return (
    <section className="knowledge-section">
      <h3>候选知识（转正）</h3>
      {error ? <p className="knowledge-toast knowledge-toast--error">{error}</p> : null}
      {message ? <p className="knowledge-toast knowledge-toast--success">{message}</p> : null}
      <p className="knowledge-meta" style={{ marginBottom: 10 }}>
        候选知识（candidate/**）仅供输入参考。转正会移动到正式目录、把元数据 status 改为 confirmed、并同步更新 INDEX.md 链接后自动提交。
      </p>
      {loading ? (
        <p className="knowledge-meta">加载候选知识…</p>
      ) : items.length === 0 ? (
        <div className="knowledge-empty" style={{ minHeight: 70 }}>暂无候选知识。</div>
      ) : (
        <div className="knowledge-file-list">
          {items.map((item) => (
            <div key={item.path} className="knowledge-file-row">
              <span className="knowledge-chip" style={{ borderRadius: 5 }}>candidate</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="knowledge-meta">{item.title || item.path}</span>
                <code style={{ marginLeft: 8 }}>{item.path}</code>
              </span>
              {editing === item.path ? (
                <span className="knowledge-actions" style={{ gap: 6 }}>
                  <input
                    type="text"
                    aria-label={`转正目标路径 ${item.path}`}
                    value={targets[item.path] ?? defaultTarget(item.path)}
                    onChange={(event) =>
                      setTargets((current) => ({ ...current, [item.path]: event.target.value }))
                    }
                    style={{ width: 220 }}
                  />
                  <button
                    type="button"
                    className="knowledge-button--primary"
                    disabled={promoting === item.path}
                    onClick={() => void promote(item.path)}
                  >
                    {promoting === item.path ? "转正中…" : "确认转正"}
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={promoting !== null}
                    onClick={() => setEditing(null)}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={promoting !== null}
                  onClick={() => setEditing(item.path)}
                >
                  转正
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
