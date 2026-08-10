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
      setMessage(`规则发现任务已排队：${queued.jobId}`);
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
    return <p className="muted">加载知识库…</p>;
  }

  return (
    <div className="knowledge-repository-detail">
      <button type="button" className="link-button" onClick={() => onNavigate("#/knowledge/repositories")}>
        返回仓库列表
      </button>
      <h2>{repository.name}</h2>
      <p className="knowledge-path">{repository.rootPath}</p>
      {message ? <p className="operation-message">{message}</p> : null}
      {error ? <p className="operation-error">{error}</p> : null}

      <section>
        <h3>仓库信息</h3>
        <dl>
          <dt>状态</dt>
          <dd>{repository.status}</dd>
          <dt>分支</dt>
          <dd>{repository.gitStatus.branch ?? "（detached HEAD）"}</dd>
          <dt>HEAD</dt>
          <dd>{repository.gitStatus.headCommit}</dd>
          <dt>revision</dt>
          <dd>{repository.revision}</dd>
        </dl>
        <div className="button-row">
          <label>
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
          <button type="button" disabled={busy} onClick={() => void handleDiscover()}>
            发现规则
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

      <section>
        <h3>最近变更集</h3>
        <ul>
          {repository.recentChangeSets.map((changeSet) => (
            <li key={changeSet.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => onNavigate(`#/knowledge/change-sets/${changeSet.id}?projectId=${changeSet.runId}`)}
              >
                {changeSet.id.slice(0, 24)}…
              </button>
              <span>{changeSet.status}</span>
              <span>{changeSet.riskLevel ?? "—"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
