import { useCallback, useEffect, useState } from "react";

import {
  RuntimeClientError,
  type KnowledgeClient,
  type KnowledgeRepositorySummary as KnowledgeRepositoryDetail,
} from "./knowledgeClient";

type Props = {
  client: KnowledgeClient;
  onNavigate: (hash: string) => void;
};

function statusClass(status: string): string {
  return `knowledge-badge knowledge-badge--${status.toLowerCase()}`;
}

export function RepositoryList({ client, onNavigate }: Props) {
  const [repositories, setRepositories] = useState<KnowledgeRepositoryDetail[]>([]);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    client
      .listRepositories()
      .then((items) => {
        if (!cancelled) setRepositories(items);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof RuntimeClientError ? caught.message : "加载知识库失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => reload(), [reload]);

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.importRepository({
        name,
        rootPath,
        autoApplyLowRisk: false,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        now: new Date().toISOString(),
      });
      setMessage("知识库导入成功");
      setName("");
      setRootPath("");
      const items = await client.listRepositories();
      setRepositories(items);
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (repository: KnowledgeRepositoryDetail) => {
    setBusy(true);
    setError(null);
    try {
      await client.removeRepository(repository.id, {
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        expectedRevision: repository.revision,
        now: new Date().toISOString(),
      });
      const items = await client.listRepositories();
      setRepositories(items);
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "移除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="knowledge-repository-list">
      <div className="knowledge-detail-header">
        <h2>本地知识库</h2>
        <span className="knowledge-meta">
          已绑定 {repositories.length} 个仓库
        </span>
      </div>

      {message ? <p className="knowledge-toast knowledge-toast--success">{message}</p> : null}
      {error ? <p className="knowledge-toast knowledge-toast--error">{error}</p> : null}

      <form
        className="knowledge-import-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleImport();
        }}
      >
        <label>
          仓库名称
          <input
            aria-label="仓库名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：物流知识库"
            required
          />
        </label>
        <label>
          本地 Git 工作树根目录
          <input
            aria-label="仓库根目录"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="例如：D:\knowledge\logistics"
            required
          />
        </label>
        <button
          type="submit"
          className="knowledge-button--primary"
          disabled={busy || !name.trim() || !rootPath.trim()}
        >
          {busy ? "导入中…" : "导入知识库"}
        </button>
      </form>

      {repositories.length === 0 ? (
        <div className="knowledge-empty">
          <div>
            <p>还没有绑定任何本地知识库。</p>
            <p>填写上方表单导入一个 Git 工作树，或先用「示例包」初始化一个知识库。</p>
          </div>
        </div>
      ) : (
        <div className="knowledge-card-grid">
          {repositories.map((repository) => (
            <article key={repository.id} className="knowledge-card">
              <div className="knowledge-card__head">
                <button
                  type="button"
                  className="link-button knowledge-card__title"
                  onClick={() => onNavigate(`#/knowledge/repositories/${repository.id}`)}
                >
                  {repository.name}
                </button>
                <span className={statusClass(repository.status)}>{repository.status}</span>
              </div>
              <dl className="knowledge-facts">
                <dt>路径</dt>
                <dd><code>{repository.rootPath}</code></dd>
                <dt>分支</dt>
                <dd>{repository.gitStatus.branch ?? "（detached HEAD）"}</dd>
                <dt>HEAD</dt>
                <dd><code>{repository.gitStatus.headCommit.slice(0, 10)}</code></dd>
                <dt>变更集</dt>
                <dd>{repository.recentChangeSets.length} 个</dd>
              </dl>
              <div className="knowledge-card__foot">
                <span className="knowledge-meta">
                  规则快照：{repository.activeRuleSnapshotId ? "已确认" : "未确认"}
                </span>
                <div className="knowledge-card__actions">
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => onNavigate(`#/knowledge/repositories/${repository.id}`)}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={busy || repository.status === "REMOVED"}
                    onClick={() => void handleRemove(repository)}
                  >
                    移除
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
