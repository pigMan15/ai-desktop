import { useCallback, useEffect, useRef, useState } from "react";

import {
  RuntimeClientError,
  type KnowledgeClient,
  type KnowledgeRepositorySummary,
  type KnowledgeRuleSnapshotSummary,
} from "./knowledgeClient";
import { KnowledgeGitPanel } from "./KnowledgeGitPanel";
import { CandidatePromote } from "./CandidatePromote";
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
  const [discoveryJob, setDiscoveryJob] = useState<{
    id: string;
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
    error: string | null;
    output: Array<{ sequence: number; kind: string; text: string }>;
  } | null>(null);
  const discoveryTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [discoveryElapsed, setDiscoveryElapsed] = useState(0);
  const discoveryLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (discoveryTimer.current) {
        clearInterval(discoveryTimer.current);
        discoveryTimer.current = null;
      }
    };
  }, []);

  // 日志自动滚动到底部
  useEffect(() => {
    const log = discoveryLogRef.current;
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }, [discoveryJob?.output]);

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
        if (cancelled) return;
        setSnapshots(items);
        // 仓库尚未激活时，自动展示最新待确认（PROPOSED）报告，刷新后仍可确认
        const proposed = items.find((item) => item.status === "PROPOSED");
        if (proposed) {
          setActiveSnapshot((current) => current ?? proposed);
        }
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
      setDiscoveryJob({ id: queued.jobId, status: queued.status, error: null, output: [] });
      setDiscoveryElapsed(0);
      // 新任务开始后收起旧的待确认报告，避免旧快照被误认为最新结果
      setActiveSnapshot(null);

      if (discoveryTimer.current) {
        clearInterval(discoveryTimer.current);
      }
      discoveryTimer.current = setInterval(async () => {
        try {
          const job = await client.getRuleDiscoveryJob(repositoryId, queued.jobId);
          const output = await client.listRuleDiscoveryOutput(repositoryId, queued.jobId, 0);
          const entries = output.items.map((item) => {
            const payload = item.payload as { text?: unknown };
            return {
              sequence: item.sequence,
              kind: item.kind,
              text:
                typeof payload.text === "string" ? payload.text : JSON.stringify(item.payload),
            };
          });
          setDiscoveryJob((current) => ({
            id: queued.jobId,
            status: job.status,
            error: job.error,
            output: entries,
          }));
          setDiscoveryElapsed((seconds) => seconds + 1);

          if (job.status === "COMPLETED") {
            if (discoveryTimer.current) {
              clearInterval(discoveryTimer.current);
              discoveryTimer.current = null;
            }
            const items = await client.listRuleSnapshots(repositoryId);
            const proposed = items.find((item) => item.status === "PROPOSED");
            if (proposed) {
              setActiveSnapshot(proposed);
              setMessage("规则发现完成，请确认报告");
            } else {
              setError(
                "任务完成但未生成规则报告（Agent 输出文件缺失或无效）。请检查上方日志，或更换 Provider / 检查 Codex 沙箱环境后重试。",
              );
            }
          } else if (job.status === "FAILED" || job.status === "CANCELLED") {
            if (discoveryTimer.current) {
              clearInterval(discoveryTimer.current);
              discoveryTimer.current = null;
            }
            setError(`规则发现未完成：${job.error ?? job.status}`);
          }
        } catch (caught: unknown) {
          if (discoveryTimer.current) {
            clearInterval(discoveryTimer.current);
            discoveryTimer.current = null;
          }
          setError(caught instanceof RuntimeClientError ? caught.message : "规则发现轮询失败");
        }
      }, 1000);
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "规则发现失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCancelDiscovery = async () => {
    if (!repository || !discoveryJob) return;
    setBusy(true);
    setError(null);
    try {
      await client.cancelRuleDiscovery(repositoryId, discoveryJob.id, {
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        expectedRevision: repository.revision,
        now: new Date().toISOString(),
      });
      setMessage("已请求取消规则发现任务");
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "取消任务失败");
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

  const refreshRepository = useCallback(() => {
    client
      .getRepository(repositoryId)
      .then((value) => setRepository(value))
      .catch(() => undefined);
  }, [client, repositoryId]);

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
      <p className="knowledge-path" title={repository.rootPath}>{repository.rootPath}</p>

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

      {discoveryJob ? (
        <section className="knowledge-section">
          <div className="knowledge-detail-header" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>规则发现任务</h3>
            <span className={`knowledge-badge knowledge-badge--${
              discoveryJob.status === "COMPLETED"
                ? "active"
                : discoveryJob.status === "FAILED" || discoveryJob.status === "CANCELLED"
                  ? "blocked"
                  : "rules-pending"
            }`}>
              {discoveryJob.status}
            </span>
          </div>
          <div className="knowledge-actions" style={{ marginBottom: 10 }}>
            <p className="knowledge-meta" style={{ margin: 0 }}>
              任务 ID：<code>{discoveryJob.id}</code>
            </p>
            <span className="knowledge-meta">
              {discoveryJob.status === "QUEUED" || discoveryJob.status === "RUNNING"
                ? `已运行 ${discoveryElapsed}s`
                : `输出 ${discoveryJob.output.length} 行`}
            </span>
            {discoveryJob.status === "QUEUED" || discoveryJob.status === "RUNNING" ? (
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => void handleCancelDiscovery()}
              >
                取消任务
              </button>
            ) : null}
          </div>
          {discoveryJob.status === "QUEUED" || discoveryJob.status === "RUNNING" ? (
            <div className="knowledge-job-progress" aria-hidden="true">
              <span />
            </div>
          ) : null}
          {discoveryJob.error ? (
            <p className="knowledge-toast knowledge-toast--error">{discoveryJob.error}</p>
          ) : null}
          <div
            ref={discoveryLogRef}
            className="knowledge-diff knowledge-job-log"
            role="log"
            aria-label="规则发现输出"
          >
            {discoveryJob.output.length === 0 ? (
              <span className="knowledge-log-line knowledge-log-line--muted">（暂无输出）</span>
            ) : (
              discoveryJob.output.map((entry) => (
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
      ) : null}

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
      {repository.status === "ACTIVE" ? (
        <CandidatePromote
          client={client}
          repositoryId={repositoryId}
          expectedRevision={repository.revision}
          onPromoted={() => void refreshRepository()}
        />
      ) : null}

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
