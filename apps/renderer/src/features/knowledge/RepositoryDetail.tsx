import { useCallback, useEffect, useState } from "react";

import {
  RuntimeClientError,
  type KnowledgeClient,
  type KnowledgeRepositorySummary,
  type KnowledgeRuleSnapshotSummary,
} from "./knowledgeClient";
import { KnowledgeGitPanel } from "./KnowledgeGitPanel";
import { RuleDiscoveryReview } from "./RuleDiscoveryReview";

type Props = {
  client: KnowledgeClient;
  repositoryId: string;
  onNavigate: (hash: string) => void;
};

export function RepositoryDetail({ client, repositoryId, onNavigate }: Props) {
  const [repository, setRepository] = useState<KnowledgeRepositorySummary | null>(null);
  const [snapshots, setSnapshots] = useState<Array<{ id: string; status: string; summary: string; openQuestions: string[] }>>([]);
  const [activeSnapshot, setActiveSnapshot] = useState<KnowledgeRuleSnapshotSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<"codex" | "claude" | "fake">("codex");

  const reload = useCallback(() => {
    let cancelled = false;
    client
      .getRepository(repositoryId)
      .then((value) => {
        if (!cancelled) {
          setRepository(value);
          setActiveSnapshot(value.activeRuleSnapshot);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof RuntimeClientError ? caught.message : "加载仓库失败");
      });
    client
      .listRuleSnapshots(repositoryId)
      .then((items) => {
        if (!cancelled) setSnapshots(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, repositoryId]);

  useEffect(() => reload(), [reload]);

  const handleDiscover = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!repository) return;
      const queued = await client.discoverRules(repositoryId, {
        provider,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        expectedRevision: repository.revision,
        now: new Date().toISOString(),
      });
      setMessage(`规则发现任务已排队：${queued.jobId.slice(0, 18)}…`);
      const deadline = Date.now() + 30_000;
      let job = await client.getRuleDiscoveryJob(repositoryId, queued.jobId);
      while (job.status === "QUEUED" || job.status === "RUNNING") {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await client.getRuleDiscoveryJob(repositoryId, queued.jobId);
      }
      if (job.status === "COMPLETED") {
        const items = await client.listRuleSnapshots(repositoryId);
        const proposed = items.find((item) => item.status === "PROPOSED");
        if (proposed) setActiveSnapshot(proposed);
        setMessage("规则发现完成，请确认报告");
      } else {
        setError(`规则发现未完成：${job.error ?? job.status}`);
      }
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "规则发现失败");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (payload: {
    writablePaths: string[];
    protectedPaths: string[];
    indexFiles: string[];
    routingFiles: string[];
    templateFiles: string[];
    validationCommands: string[];
    summary: string;
    openQuestions: string[];
  }) => {
    if (!repository || !activeSnapshot) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.confirmRuleSnapshot(repositoryId, activeSnapshot.id, {
        ...payload,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        expectedRevision: repository.revision,
        now: new Date().toISOString(),
      });
      setRepository(updated);
      setActiveSnapshot(updated.activeRuleSnapshot);
      setMessage("规则快照已确认，仓库已激活");
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "确认失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSettings = async (autoApplyLowRisk: boolean) => {
    if (!repository) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.updateSettings(repositoryId, {
        autoApplyLowRisk,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        expectedRevision: repository.revision,
        now: new Date().toISOString(),
      });
      setRepository(updated);
      setMessage("设置已更新");
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "更新设置失败");
    } finally {
      setBusy(false);
    }
  };

  if (!repository) {
    return <div className="knowledge-empty">加载知识库…</div>;
  }

  return (
    <div className="knowledge-repository-detail">
      <div className="knowledge-detail-header">
        <button type="button" className="quiet-button" onClick={() => onNavigate("#/knowledge/repositories")}>
          ← 返回仓库列表
        </button>
        <h2>{repository.name}</h2>
        <span className={`knowledge-badge knowledge-badge--${repository.status.toLowerCase()}`}>
          {repository.status}
        </span>
      </div>
      <p className="knowledge-meta"><code>{repository.rootPath}</code></p>

      {message ? <p className="knowledge-toast knowledge-toast--success">{message}</p> : null}
      {error ? <p className="knowledge-toast knowledge-toast--error">{error}</p> : null}

      <section className="knowledge-section">
        <h3>仓库信息</h3>
        <div className="knowledge-git-grid">
          <dl className="knowledge-facts">
            <dt>分支</dt>
            <dd>{repository.gitStatus.branch ?? "（detached HEAD）"}</dd>
            <dt>HEAD</dt>
            <dd><code>{repository.gitStatus.headCommit.slice(0, 12)}</code></dd>
            <dt>revision</dt>
            <dd><code>{repository.revision}</code></dd>
            <dt>规则快照</dt>
            <dd>{repository.activeRuleSnapshot ? repository.activeRuleSnapshot.summary.slice(0, 40) : "未确认"}</dd>
            <dt>工作区</dt>
            <dd>{repository.gitStatus.dirty ? "有未提交变更" : "干净"}</dd>
          </dl>
          <div className="knowledge-actions">
            <label className="knowledge-meta">
              Provider
              <select
                aria-label="Provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value as "codex" | "claude" | "fake")}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
                <option value="fake">Fake</option>
              </select>
            </label>
            <button type="button" className="knowledge-button--primary" disabled={busy} onClick={() => void handleDiscover()}>
              {busy ? "处理中…" : "发现规则"}
            </button>
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={repository.autoApplyLowRisk}
                onChange={(event) => void handleSettings(event.target.checked)}
                disabled={busy}
              />
              LOW 风险自动写入
            </label>
          </div>
        </div>
      </section>

      {activeSnapshot && activeSnapshot.status === "PROPOSED" ? (
        <RuleDiscoveryReview
          snapshot={activeSnapshot}
          expectedRevision={repository.revision}
          busy={busy}
          onConfirm={(payload) => void handleConfirm(payload)}
          onCancel={() => setActiveSnapshot(null)}
        />
      ) : null}

      <KnowledgeGitPanel client={client} repositoryId={repositoryId} />

      <section className="knowledge-section">
        <h3>最近变更集</h3>
        {repository.recentChangeSets.length === 0 ? (
          <div className="knowledge-empty" style={{ minHeight: 70 }}>
            该仓库还没有变更集。从 Run 产物创建第一个知识变更集。
          </div>
        ) : (
          <div className="knowledge-file-list">
            {repository.recentChangeSets.map((changeSet) => (
              <div key={changeSet.id} className="knowledge-file-row">
                <span className={`knowledge-badge knowledge-badge--${changeSet.riskLevel?.toLowerCase() ?? "low"}`}>
                  {changeSet.riskLevel ?? "—"}
                </span>
                <span className={`knowledge-badge`}>{changeSet.status}</span>
                <span>{changeSet.id.slice(0, 24)}…</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onNavigate(`#/knowledge/change-sets/${changeSet.id}?projectId=${changeSet.runId}`)}
                >
                  查看
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
