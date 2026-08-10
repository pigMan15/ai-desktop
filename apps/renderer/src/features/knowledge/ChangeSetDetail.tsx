import { useEffect, useState } from "react";

import type { KnowledgeChangeSetDetail } from "@workflow-platform/contracts";
import type { KnowledgeClient } from "./knowledgeClient";
import { useKnowledgeChangeSetPage } from "./useKnowledgeChangeSetPage";
import { ChangeSetProgress } from "./ChangeSetProgress";
import { KnowledgeDiffViewer } from "./KnowledgeDiffViewer";

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
      <div className="knowledge-detail-header">
        <button type="button" className="quiet-button" onClick={() => onNavigate("#/knowledge/repositories")}>
          ← 返回知识库
        </button>
        <h2>知识变更集</h2>
        {changeSet ? (
          <>
            <span className={`knowledge-badge`}>{changeSet.status}</span>
            {changeSet.riskLevel ? (
              <span className={`knowledge-badge knowledge-badge--${changeSet.riskLevel.toLowerCase()}`}>
                风险 {changeSet.riskLevel}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {state.operationMessage ? (
        <p className="knowledge-toast knowledge-toast--success">{state.operationMessage}</p>
      ) : null}
      {state.error ? <p className="knowledge-toast knowledge-toast--error">{state.error}</p> : null}

      {!changeSet ? (
        <div className="knowledge-empty">加载变更集…</div>
      ) : (
        <>
          <section className="knowledge-section">
            <h3>概览</h3>
            <dl className="knowledge-facts">
              <dt>风险</dt>
              <dd>{changeSet.riskLevel ?? "—"}</dd>
              <dt>风险原因</dt>
              <dd>{changeSet.riskReasons.join("；") || "—"}</dd>
              <dt>revision</dt>
              <dd><code>{changeSet.revision}</code></dd>
              <dt>仓库</dt>
              <dd>{changeSet.repository?.name ?? changeSet.repositoryId}</dd>
              <dt>来源 Artifact</dt>
              <dd>{changeSet.sourceArtifacts.length} 个</dd>
            </dl>
          </section>

          <section className="knowledge-section">
            <h3>文件变更（{changeSet.fileChanges.length}）</h3>
            {changeSet.fileChanges.length === 0 ? (
              <div className="knowledge-empty" style={{ minHeight: 70 }}>
                尚未生成文件变更。
              </div>
            ) : (
              <div className="knowledge-file-list">
                {changeSet.fileChanges.map((fileChange) => (
                  <div key={fileChange.path} className="knowledge-file-row">
                    <span className={`knowledge-badge knowledge-badge--${fileChange.operation.toLowerCase()}`}>
                      {fileChange.operation}
                    </span>
                    <span className="knowledge-chip" style={{ borderRadius: 5 }}>{fileChange.category}</span>
                    <span>{fileChange.path}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {changeSet.status === "GENERATING" || changeSet.status === "APPLYING" ? (
            <ChangeSetProgress
              client={client}
              projectId={projectId}
              runId={runId}
              changeSetId={changeSet.id}
              status={changeSet.status}
            />
          ) : null}

          {changeSet.unifiedDiff ? (
            <section className="knowledge-section">
              <h3>统一 diff</h3>
              <KnowledgeDiffViewer diff={changeSet.unifiedDiff} />
            </section>
          ) : null}

          <section className="knowledge-section">
            <h3>操作</h3>
            <div className="knowledge-actions">
              {actions.includes("generate") ? (
                <button
                  type="button"
                  className="knowledge-button--primary"
                  onClick={() => void runAction((input) => client.generateChangeSet(projectId, runId, changeSetId, input), "生成")}
                >
                  生成变更集
                </button>
              ) : null}
              {actions.includes("approve") ? (
                <>
                  <input
                    type="text"
                    aria-label="审核意见"
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="审核意见"
                  />
                  <button
                    type="button"
                    className="knowledge-button--primary"
                    onClick={() => void runAction((input) => client.approveChangeSet(projectId, runId, changeSetId, { ...input, comment }), "审核通过")}
                  >
                    通过
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => void runAction((input) => client.rejectChangeSet(projectId, runId, changeSetId, { ...input, comment }), "拒绝")}
                  >
                    拒绝
                  </button>
                </>
              ) : null}
              {actions.includes("apply") ? (
                <button
                  type="button"
                  className="knowledge-button--primary"
                  onClick={() => void runAction((input) => client.applyChangeSet(projectId, runId, changeSetId, input), "应用")}
                >
                  应用
                </button>
              ) : null}
              {actions.includes("abandon") ? (
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => void runAction((input) => client.abandonChangeSet(projectId, runId, changeSetId, { ...input, reason: "用户放弃" }), "放弃")}
                >
                  放弃
                </button>
              ) : null}
            </div>

            {actions.includes("stage") || actions.includes("unstage") || actions.includes("commit") ? (
              <div className="knowledge-section" style={{ marginTop: 14, background: "var(--surface-subtle)" }}>
                <h3 style={{ marginBottom: 10 }}>Git 操作</h3>
                <div className="knowledge-actions">
                  {actions.includes("stage") ? (
                    <button
                      type="button"
                      className="quiet-button"
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
                      className="quiet-button"
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
                  <div className="knowledge-actions" style={{ marginTop: 10 }}>
                    <input type="text" aria-label="提交标题" value={commitTitle} onChange={(event) => setCommitTitle(event.target.value)} placeholder="提交标题" />
                    <input type="text" aria-label="提交正文" value={commitBody} onChange={(event) => setCommitBody(event.target.value)} placeholder="提交正文（可选）" />
                    <button
                      type="button"
                      className="knowledge-button--primary"
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
              </div>
            ) : null}
          </section>
        </>
      )}

      <div className="knowledge-actions">
        <button type="button" className="quiet-button" onClick={refresh}>
          刷新
        </button>
      </div>
    </div>
  );
}
