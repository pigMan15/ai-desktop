import { useEffect, useState } from "react";

import type { KnowledgeChangeSetDetail } from "@workflow-platform/contracts";
import type { KnowledgeClient } from "./knowledgeClient";
import { useKnowledgeChangeSetPage } from "./useKnowledgeChangeSetPage";

type Props = {
  client: KnowledgeClient;
  projectId: string;
  runId: string;
  changeSetId: string;
  onNavigate: (hash: string) => void;
};

export function ChangeSetDetail({ client, projectId, runId, changeSetId, onNavigate }: Props) {
  const { state, refresh, runAction } = useKnowledgeChangeSetPage(client, projectId, runId, changeSetId);
  const [comment, setComment] = useState("");
  const [commitTitle, setCommitTitle] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [repositoryRevision, setRepositoryRevision] = useState("1");
  const changeSet: KnowledgeChangeSetDetail | null = state.changeSet;

  const loadedChangeSetId = changeSet?.id ?? null;
  const repositoryId = changeSet?.repositoryId ?? null;
  useEffect(() => {
    if (!repositoryId) return;
    let cancelled = false;
    client
      .getRepository(repositoryId)
      .then((repository) => {
        if (!cancelled) setRepositoryRevision(repository.revision);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedChangeSetId, repositoryId, client]);

  const actions = changeSet?.allowedActions ?? [];

  const refreshRepositoryRevision = async () => {
    try {
      if (!repositoryId) return repositoryRevision;
      const repository = await client.getRepository(repositoryId);
      setRepositoryRevision(repository.revision);
      return repository.revision;
    } catch {
      return repositoryRevision;
    }
  };

  return (
    <div className="knowledge-change-set-detail">
      <button type="button" className="link-button" onClick={() => onNavigate("#/knowledge/repositories")}>
        返回知识库
      </button>
      <h2>知识变更集</h2>
      {state.operationMessage ? <p className="operation-message">{state.operationMessage}</p> : null}
      {state.error ? <p className="operation-error">{state.error}</p> : null}
      {!changeSet ? <p className="muted">加载中…</p> : null}
      {changeSet ? (
        <>
          <dl>
            <dt>状态</dt>
            <dd>{changeSet.status}</dd>
            <dt>风险</dt>
            <dd>{changeSet.riskLevel ?? "—"}</dd>
            <dt>风险原因</dt>
            <dd>{changeSet.riskReasons.join("；") || "—"}</dd>
            <dt>revision</dt>
            <dd>{changeSet.revision}</dd>
            <dt>仓库</dt>
            <dd>{changeSet.repository?.name ?? changeSet.repositoryId}</dd>
          </dl>

          <section>
            <h3>文件变更</h3>
            <ul>
              {changeSet.fileChanges.map((fileChange) => (
                <li key={fileChange.path}>
                  <span className="file-operation">{fileChange.operation}</span> {fileChange.path}
                  <span className="file-category">{fileChange.category}</span>
                </li>
              ))}
            </ul>
          </section>

          {changeSet.unifiedDiff ? (
            <section>
              <h3>统一 diff</h3>
              <pre className="knowledge-diff">{changeSet.unifiedDiff}</pre>
            </section>
          ) : null}

          <div className="button-row">
            {actions.includes("generate") ? (
              <button type="button" onClick={() => void runAction((input) => client.generateChangeSet(projectId, runId, changeSetId, input), "生成")}>
                生成变更集
              </button>
            ) : null}
            {actions.includes("approve") ? (
              <span>
                <input aria-label="审核意见" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="审核意见" />
                <button
                  type="button"
                  onClick={() => void runAction((input) => client.approveChangeSet(projectId, runId, changeSetId, { ...input, comment }), "审核通过")}
                >
                  通过
                </button>
                <button
                  type="button"
                  onClick={() => void runAction((input) => client.rejectChangeSet(projectId, runId, changeSetId, { ...input, comment }), "拒绝")}
                >
                  拒绝
                </button>
              </span>
            ) : null}
            {actions.includes("apply") ? (
              <button type="button" onClick={() => void runAction((input) => client.applyChangeSet(projectId, runId, changeSetId, input), "应用")}>
                应用
              </button>
            ) : null}
            {actions.includes("abandon") ? (
              <button
                type="button"
                onClick={() => void runAction((input) => client.abandonChangeSet(projectId, runId, changeSetId, { ...input, reason: "用户放弃" }), "放弃")}
              >
                放弃
              </button>
            ) : null}
          </div>

          {(actions.includes("stage") || actions.includes("unstage") || actions.includes("commit")) ? (
            <section>
              <h3>Git 操作</h3>
              <div className="button-row">
                {actions.includes("stage") ? (
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        const revision = await refreshRepositoryRevision();
                        await runAction(
                          (input) =>
                            client.gitStage(projectId, runId, changeSetId, {
                              ...input,
                              paths: changeSet.fileChanges.map((file) => file.path),
                              expectedRepositoryRevision: revision,
                            }),
                          "暂存",
                        );
                      })()
                    }
                  >
                    暂存全部
                  </button>
                ) : null}
                {actions.includes("unstage") ? (
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        const revision = await refreshRepositoryRevision();
                        await runAction(
                          (input) =>
                            client.gitUnstage(projectId, runId, changeSetId, {
                              ...input,
                              paths: changeSet.fileChanges.map((file) => file.path),
                              expectedRepositoryRevision: revision,
                            }),
                          "取消暂存",
                        );
                      })()
                    }
                  >
                    取消暂存全部
                  </button>
                ) : null}
              </div>
              {actions.includes("commit") ? (
                <div className="commit-form">
                  <input aria-label="提交标题" value={commitTitle} onChange={(event) => setCommitTitle(event.target.value)} placeholder="提交标题" />
                  <input aria-label="提交正文" value={commitBody} onChange={(event) => setCommitBody(event.target.value)} placeholder="提交正文" />
                  <button
                    type="button"
                    disabled={!commitTitle.trim()}
                    onClick={() =>
                      void (async () => {
                        const revision = await refreshRepositoryRevision();
                        await runAction(
                          (input) =>
                            client.gitCommit(projectId, runId, changeSetId, {
                              ...input,
                              title: commitTitle,
                              body: commitBody,
                              paths: changeSet.fileChanges.map((file) => file.path),
                              expectedRepositoryRevision: revision,
                            }),
                          "提交",
                        );
                      })()
                    }
                  >
                    提交
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      <button type="button" onClick={refresh}>
        刷新
      </button>
    </div>
  );
}
