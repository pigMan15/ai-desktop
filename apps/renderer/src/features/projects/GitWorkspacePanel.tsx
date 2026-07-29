import { useState } from "react";

export type GitWorkspaceStatus = {
  rootPath: string;
  branch: string | null;
  detachedHead: boolean;
  dirty: boolean;
  changes: string[];
};

export type GitWorktree = {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
};

type Props = {
  projectPath: string;
  status: GitWorkspaceStatus | null;
  worktrees: GitWorktree[];
  onRefresh: () => void;
  onCreateWorktree: (branch: string) => void;
  onRemoveWorktree: (worktreePath: string) => void;
  onMergeBack: (branch: string) => void;
  onPush: () => void;
};

export function GitWorkspacePanel({
  projectPath,
  status,
  worktrees,
  onRefresh,
  onCreateWorktree,
  onRemoveWorktree,
  onMergeBack,
  onPush,
}: Props) {
  const [branch, setBranch] = useState("");
  const usable = Boolean(projectPath.trim());

  return (
    <section className="panel" aria-labelledby="git-workspace-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Git</p>
          <h2 id="git-workspace-title">Git 工作区</h2>
        </div>
        <span className="status-pill">
          {status?.detachedHead ? "分离 HEAD" : status?.dirty ? "存在未提交变更" : "工作区干净"}
        </span>
      </div>
      {status ? (
        <>
          <p className="body-copy">当前分支：{status.branch ?? "无"}</p>
          {status.changes.length > 0 ? (
            <ul className="compact-list" aria-label="Git 未提交变更">
              {status.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="body-copy">尚未读取 Git 状态。</p>
      )}
      <div className="button-row">
        <button className="quiet-button" disabled={!usable} onClick={onRefresh}>
          刷新 Git 状态
        </button>
        <button className="quiet-button" disabled={!usable || !status || status.dirty || status.detachedHead} onClick={onPush}>
          推送当前分支
        </button>
      </div>
      <div className="form-grid">
        <label>
          新分支名称
          <input value={branch} onChange={(event) => setBranch(event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button
          className="quiet-button"
          disabled={!usable || !branch.trim() || !status || status.dirty || status.detachedHead}
          onClick={() => {
            onCreateWorktree(branch.trim());
            setBranch("");
          }}
        >
          创建 Worktree
        </button>
      </div>
      <div className="table-like" role="table" aria-label="Git Worktree 列表">
        <div role="row" className="table-row table-head">
          <span role="columnheader">分支</span>
          <span role="columnheader">路径</span>
          <span role="columnheader">操作</span>
        </div>
        {worktrees.map((worktree) => (
          <div role="row" className="table-row" key={worktree.path}>
            <span role="cell">{worktree.branch ?? "分离 HEAD"}</span>
            <span role="cell">{worktree.path}</span>
            <span role="cell" className="button-row">
              {worktree.branch && worktree.branch !== status?.branch ? (
                <button
                  className="quiet-button"
                  disabled={!status || status.dirty || status.detachedHead}
                  onClick={() => onMergeBack(worktree.branch!)}
                >
                  合并 {worktree.branch}
                </button>
              ) : null}
              {worktree.path !== status?.rootPath ? (
                <button className="quiet-button" onClick={() => onRemoveWorktree(worktree.path)}>
                  清理
                </button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
