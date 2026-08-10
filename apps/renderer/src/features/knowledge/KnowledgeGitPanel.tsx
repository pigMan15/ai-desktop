import { useEffect, useState } from "react";

import { RuntimeClientError, type KnowledgeClient } from "./knowledgeClient";

type Props = {
  client: KnowledgeClient;
  repositoryId: string;
};

export function KnowledgeGitPanel({ client, repositoryId }: Props) {
  const [status, setStatus] = useState<{
    branch: string | null;
    headCommit: string;
    dirty: boolean;
    conflict: boolean;
    stagedPaths: string[];
    unstagedPaths: string[];
  } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [scope, setScope] = useState<"working" | "staged">("working");
  const [error, setError] = useState<string | null>(null);

  const loadStatus = () => {
    client
      .gitStatus(repositoryId)
      .then((value) => setStatus(value))
      .catch((caught: unknown) => {
        setError(caught instanceof RuntimeClientError ? caught.message : "读取 Git 状态失败");
      });
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, repositoryId]);

  const loadDiff = () => {
    client
      .gitDiff(repositoryId, scope)
      .then((value) => setDiff(value.diff))
      .catch((caught: unknown) => {
        setError(caught instanceof RuntimeClientError ? caught.message : "读取 diff 失败");
      });
  };

  return (
    <div className="knowledge-git-panel">
      <h4>Git 状态</h4>
      {error ? <p className="operation-error">{error}</p> : null}
      {status ? (
        <dl>
          <dt>分支</dt>
          <dd>{status.branch ?? "（detached HEAD）"}</dd>
          <dt>HEAD</dt>
          <dd>{status.headCommit}</dd>
          <dt>工作区</dt>
          <dd>{status.dirty ? "有未提交变更" : "干净"}</dd>
          <dt>冲突</dt>
          <dd>{status.conflict ? "存在冲突" : "无"}</dd>
          <dt>已暂存</dt>
          <dd>{status.stagedPaths.join("、") || "无"}</dd>
          <dt>未暂存</dt>
          <dd>{status.unstagedPaths.join("、") || "无"}</dd>
        </dl>
      ) : null}
      <div className="button-row">
        <button type="button" onClick={loadStatus}>
          刷新状态
        </button>
        <select
          aria-label="diff 范围"
          value={scope}
          onChange={(event) => setScope(event.target.value as "working" | "staged")}
        >
          <option value="working">工作区</option>
          <option value="staged">暂存区</option>
        </select>
        <button type="button" onClick={loadDiff}>
          查看 diff
        </button>
      </div>
      {diff !== null ? <pre className="knowledge-diff">{diff}</pre> : null}
    </div>
  );
}
