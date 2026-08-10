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
      reload();
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
      reload();
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "移除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="knowledge-repository-list">
      <h2>本地知识库</h2>
      {message ? <p className="operation-message">{message}</p> : null}
      {error ? <p className="operation-error">{error}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleImport();
        }}
      >
        <input
          aria-label="仓库名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="仓库名称"
          required
        />
        <input
          aria-label="仓库根目录"
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          placeholder="本地 Git 工作树根目录"
          required
        />
        <button type="submit" disabled={busy || !name.trim() || !rootPath.trim()}>
          导入
        </button>
      </form>
      <ul>
        {(repositories ?? []).map((repository) => (
          <li key={repository.id}>
            <button
              type="button"
              className="link-button"
              onClick={() => onNavigate(`#/knowledge/repositories/${repository.id}`)}
            >
              {repository.name}
            </button>
            <span className={`knowledge-status knowledge-status-${repository.status.toLowerCase()}`}>
              {repository.status}
            </span>
            <span className="knowledge-path">{repository.rootPath}</span>
            <button
              type="button"
              disabled={busy || repository.status === "REMOVED"}
              onClick={() => void handleRemove(repository)}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
