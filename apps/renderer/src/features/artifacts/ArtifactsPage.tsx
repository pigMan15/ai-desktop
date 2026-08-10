import { useEffect, useMemo, useState } from "react";

import type {
  ArtifactConsumer,
  ArtifactPreview,
  EvidencePackage,
  KnowledgeSynthesis,
  RunSummary,
  RuntimeReport,
  RuntimeWorkbenchState,
} from "../../app/runtimeClient";
import { RuntimeClientError } from "../../app/runtimeClient";
import { buildRunDetailHash, type RunContext } from "../../app/routes";
import { diffArtifactText } from "./artifactDiff";

type Artifact = RuntimeWorkbenchState["artifacts"][number];

type Props = {
  context?: RunContext;
  client?: {
    listArtifacts: (projectId: string, runId: string, signal?: AbortSignal) => Promise<Artifact[]>;
    previewArtifact: (projectId: string, runId: string, artifactId: string, signal?: AbortSignal) => Promise<ArtifactPreview>;
    listArtifactConsumers: (projectId: string, runId: string, artifactId: string, signal?: AbortSignal) => Promise<ArtifactConsumer[]>;
    getEvidencePackage?: (projectId: string, runId: string, signal?: AbortSignal) => Promise<EvidencePackage>;
    getRunReport?: (projectId: string, runId: string, signal?: AbortSignal) => Promise<RuntimeReport>;
  };
  state: RuntimeWorkbenchState | null;
  artifacts?: Artifact[];
  runs?: RunSummary[];
  extractionCountsByArtifactId?: Record<string, number>;
  preview?: ArtifactPreview | null;
  onClosePreview?: () => void;
  onPreviewArtifact?: (runId: string, artifactId: string) => void;
  onCompareArtifacts?: (beforeRunId: string, beforeArtifactId: string, afterRunId: string, afterArtifactId: string) => void;
  onDownloadEvidencePackage?: () => void;
  onDownloadReport?: () => void;
  onConfirmArtifact?: (runId: string, artifact: Artifact) => void;
  onLoadArtifactConsumers?: (runId: string, artifactId: string) => Promise<ArtifactConsumer[]>;
  onStartKnowledgeExtraction?: (
    runId: string,
    artifactIds: string[],
    provider: KnowledgeSynthesis["provider"],
  ) => Promise<void> | void;
  comparison?: {
    before: { id: string; content: string };
    after: { id: string; content: string };
  } | null;
};

export function ArtifactsPage({
  context,
  client,
  state,
  artifacts: providedArtifacts,
  runs = [],
  extractionCountsByArtifactId = {},
  preview = null,
  onClosePreview,
  onPreviewArtifact,
  onCompareArtifacts,
  onDownloadEvidencePackage,
  onDownloadReport,
  onConfirmArtifact,
  onLoadArtifactConsumers,
  onStartKnowledgeExtraction,
  comparison = null,
}: Props) {
  const [scopedArtifacts, setScopedArtifacts] = useState<Artifact[] | null>(null);
  const [scopedPreview, setScopedPreview] = useState<ArtifactPreview | null>(null);
  const [scopedComparison, setScopedComparison] = useState<Props["comparison"]>(null);
  const [scopedError, setScopedError] = useState<RuntimeClientError | null>(null);
  const artifacts = scopedArtifacts ?? providedArtifacts ?? (Array.isArray(state?.artifacts) ? state.artifacts : []);
  const effectivePreview = scopedPreview ?? preview;
  const effectiveComparison = scopedComparison ?? comparison;
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [provider, setProvider] = useState<KnowledgeSynthesis["provider"]>("codex");
  const [beforeArtifactId, setBeforeArtifactId] = useState("");
  const [afterArtifactId, setAfterArtifactId] = useState("");
  const [consumersByArtifact, setConsumersByArtifact] = useState<Record<string, ArtifactConsumer[]>>({});

  useEffect(() => {
    if (!context || !client) return;
    const controller = new AbortController();
    setScopedArtifacts(null);
    setScopedError(null);
    void client.listArtifacts(context.projectId, context.runId, controller.signal)
      .then((items) => { if (!controller.signal.aborted) setScopedArtifacts(items); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setScopedError(error instanceof RuntimeClientError ? error : new RuntimeClientError(null, "RUNTIME_ERROR", error instanceof Error ? error.message : String(error), undefined, null));
      });
    return () => controller.abort();
  }, [client, context?.projectId, context?.runId]);

  async function previewScopedArtifact(artifact: Artifact) {
    if (!context || !client) return;
    try {
      setScopedPreview(await client.previewArtifact(context.projectId, context.runId, artifact.id));
    } catch (error) {
      setScopedError(error instanceof RuntimeClientError ? error : new RuntimeClientError(null, "RUNTIME_ERROR", error instanceof Error ? error.message : String(error), undefined, null));
    }
  }

  async function loadScopedConsumers(artifact: Artifact) {
    if (!context || !client) return;
    try {
      const consumers = await client.listArtifactConsumers(context.projectId, context.runId, artifact.id);
      setConsumersByArtifact((current) => ({ ...current, [artifact.id]: consumers }));
    } catch (error) {
      setScopedError(error instanceof RuntimeClientError ? error : new RuntimeClientError(null, "RUNTIME_ERROR", error instanceof Error ? error.message : String(error), undefined, null));
    }
  }

  async function compareScopedArtifacts() {
    if (!context || !client || !beforeArtifactId || !afterArtifactId) return;
    try {
      const [before, after] = await Promise.all([
        client.previewArtifact(context.projectId, context.runId, beforeArtifactId),
        client.previewArtifact(context.projectId, context.runId, afterArtifactId),
      ]);
      if (before.integrity !== "verified" || after.integrity !== "verified") throw new Error("产物内容已变更，不能生成可信差异");
      if (before.truncated || after.truncated) throw new Error("产物预览已截断，不能生成完整差异");
      if (before.content === null || after.content === null) throw new Error("二进制产物不支持文本差异比较");
      setScopedComparison({
        before: { id: before.id, content: before.content },
        after: { id: after.id, content: after.content },
      });
    } catch (failure) {
      setScopedError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
    }
  }

  async function downloadScopedEvidencePackage() {
    if (!context || !client?.getEvidencePackage) return;
    try {
      const evidencePackage = await client.getEvidencePackage(context.projectId, context.runId);
      downloadTextFile(`${context.runId}-evidence-package.json`, JSON.stringify(evidencePackage, null, 2), "application/json");
    } catch (failure) {
      setScopedError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
    }
  }

  async function downloadScopedReport() {
    if (!context || !client?.getRunReport) return;
    try {
      const report = await client.getRunReport(context.projectId, context.runId);
      downloadTextFile(report.fileName, report.content, report.mediaType);
    } catch (failure) {
      setScopedError(failure instanceof RuntimeClientError ? failure : new RuntimeClientError(null, "RUNTIME_ERROR", failure instanceof Error ? failure.message : String(failure), undefined, null));
    }
  }

  const visibleArtifacts = useMemo(
    () => artifacts.filter((artifact) => !selectedRunId || artifact.runId === selectedRunId),
    [artifacts, selectedRunId],
  );
  const artifactById = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const selectedArtifacts = selectedArtifactIds
    .map((artifactId) => artifactById.get(artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const extractionRunId = selectedArtifacts[0]?.runId ?? "";
  const canExtract = Boolean(
    onStartKnowledgeExtraction &&
    extractionRunId &&
    selectedArtifacts.length > 0 &&
    selectedArtifacts.every((artifact) => artifact.runId === extractionRunId && artifact.status === "verified"),
  );

  function toggleArtifactSelection(artifact: Artifact) {
    if (artifact.status !== "verified") {
      return;
    }
    setSelectedArtifactIds((current) => {
      if (current.includes(artifact.id)) {
        return current.filter((artifactId) => artifactId !== artifact.id);
      }
      if (current.length > 0 && artifactById.get(current[0])?.runId !== artifact.runId) {
        return [artifact.id];
      }
      return [...current, artifact.id];
    });
  }

  async function startKnowledgeExtraction() {
    if (!canExtract || !onStartKnowledgeExtraction) {
      return;
    }
    await onStartKnowledgeExtraction(extractionRunId, selectedArtifacts.map((artifact) => artifact.id), provider);
    setSelectedArtifactIds([]);
  }

  return (
    <section id="artifacts" className="panel page-workspace page-artifacts" aria-labelledby="artifacts-title">
      {context ? <div className="button-row"><a className="quiet-button" href={buildRunDetailHash(context.runId)}>返回 Run</a><span className="status-pill">{scopedError ? "加载失败" : `${artifacts.length} 项`}</span></div> : null}
      {scopedError ? <p role="alert" className="body-copy">{scopedError.message}</p> : null}
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Evidence</p>
          <h2 id="artifacts-title">产物</h2>
        </div>
        <span className="status-pill">{artifacts.length > 0 ? `已索引 ${artifacts.length} 项` : "等待产物"}</span>
      </div>
      <p className="body-copy">集中查看所有 Run 的可追溯产物。已验证的文本产物可批量交给 Codex 或 Claude CLI 合成，结果在知识库中审核和发布。</p>
      <div className="artifact-toolbar">
        <label>
          Run 筛选
          <select aria-label="Run 筛选" value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)}>
            <option value="">全部 Run</option>
            {runs.map((run) => <option key={run.id} value={run.id}>{run.title}</option>)}
          </select>
        </label>
        {selectedArtifacts.length > 0 ? <span className="status-pill">已选择 {selectedArtifacts.length} 项</span> : null}
      </div>
      {onStartKnowledgeExtraction ? (
        <div className="artifact-extraction" aria-label="CLI 知识合成">
          <div>
            <p className="section-kicker">Knowledge extraction</p>
            <strong>选择已验证产物后合成知识</strong>
          </div>
          <label>
            CLI 提供商
            <select aria-label="CLI 提供商" value={provider} onChange={(event) => setProvider(event.target.value as KnowledgeSynthesis["provider"])}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <button className="quiet-button" disabled={!canExtract} onClick={() => void startKnowledgeExtraction()}>开始 CLI 合成</button>
        </div>
      ) : null}
      {onDownloadEvidencePackage || onDownloadReport || client?.getEvidencePackage || client?.getRunReport ? (
        <div className="button-row" aria-label="证据导出">
          {client?.getEvidencePackage && context ? <button className="quiet-button" onClick={() => void downloadScopedEvidencePackage()}>下载证据包</button> : onDownloadEvidencePackage ? <button className="quiet-button" onClick={onDownloadEvidencePackage}>下载证据包</button> : null}
          {client?.getRunReport && context ? <button className="quiet-button" onClick={() => void downloadScopedReport()}>下载运行报告</button> : onDownloadReport ? <button className="quiet-button" onClick={onDownloadReport}>下载运行报告</button> : null}
        </div>
      ) : null}
      {visibleArtifacts.length > 0 ? (
        <>
          {onCompareArtifacts || (context && client) ? (
            <div className="gate-record" aria-label="产物比较">
              <div className="panel-heading"><strong>文本差异比较</strong><span className="status-pill">Runtime 预览</span></div>
              <div className="button-row">
                <label>基准产物<select aria-label="基准产物" value={beforeArtifactId} onChange={(event) => setBeforeArtifactId(event.target.value)}><option value="">选择基准</option>{visibleArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.type} · {artifact.id}</option>)}</select></label>
                <label>对比产物<select aria-label="对比产物" value={afterArtifactId} onChange={(event) => setAfterArtifactId(event.target.value)}><option value="">选择对比项</option>{visibleArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.type} · {artifact.id}</option>)}</select></label>
                <button className="quiet-button" disabled={!beforeArtifactId || !afterArtifactId || beforeArtifactId === afterArtifactId} onClick={() => {
                  const before = artifactById.get(beforeArtifactId);
                  const after = artifactById.get(afterArtifactId);
                  if (context && client) void compareScopedArtifacts();
                  else if (before?.runId && after?.runId) onCompareArtifacts?.(before.runId, before.id, after.runId, after.id);
                }}>比较产物</button>
              </div>
            </div>
          ) : null}
          <div className="gate-stack" aria-label="产物记录">
            {visibleArtifacts.map((artifact) => {
              const extractionCount = extractionCountsByArtifactId[artifact.id] ?? 0;
              const runTitle = runs.find((run) => run.id === artifact.runId)?.title ?? artifact.runId ?? "未关联 Run";
              return <article key={artifact.id} className="gate-record">
                <div className="panel-heading">
                  <div className="artifact-card-title">
                    {onStartKnowledgeExtraction ? <input aria-label={`选择产物 ${artifact.id}`} type="checkbox" checked={selectedArtifactIds.includes(artifact.id)} disabled={artifact.status !== "verified"} onChange={() => toggleArtifactSelection(artifact)} /> : null}
                    <strong>{artifact.type}</strong>
                  </div>
                  <div className="status-group">
                    <span className={`status-pill${artifact.status === "invalidated" ? " status-blocked" : ""}`}>{artifact.status === "invalidated" ? "已失效" : artifact.status === "provisional" ? "待确认" : "已校验"}</span>
                    <span className="status-pill">{extractionCount > 0 ? `已提取 ${extractionCount} 次` : "未提取"}</span>
                  </div>
                </div>
                <dl className="facts">
                  <div><dt>所属 Run</dt><dd>{runTitle}</dd></div>
                  <div><dt>产物标识</dt><dd>{artifact.id}</dd></div>
                  <div><dt>安全位置</dt><dd>{artifact.relativePath ?? artifact.uri}</dd></div>
                  {artifact.artifactSpecId ? <div><dt>交付物规格</dt><dd>{artifact.artifactSpecId}</dd></div> : null}
                  {artifact.supersedesArtifactId ? <div><dt>替代版本</dt><dd>{artifact.supersedesArtifactId}</dd></div> : null}
                  <div><dt>内容哈希</dt><dd>{artifact.contentHash}</dd></div>
                </dl>
                <div className="button-row">
                  <button className="quiet-button" onClick={() => context ? void previewScopedArtifact(artifact) : artifact.runId && onPreviewArtifact?.(artifact.runId, artifact.id)}>查看内容</button>
                  {artifact.status === "provisional" ? <button className="quiet-button" onClick={() => artifact.runId && onConfirmArtifact?.(artifact.runId, artifact)}>确认为正式产物</button> : null}
                  {context && client ? <button className="quiet-button" onClick={() => void loadScopedConsumers(artifact)}>查看使用记录</button> : onLoadArtifactConsumers ? <button className="quiet-button" onClick={() => {
                    if (!artifact.runId) return;
                    void onLoadArtifactConsumers(artifact.runId, artifact.id).then((consumers) => setConsumersByArtifact((current) => ({ ...current, [artifact.id]: consumers })));
                  }}>查看使用记录</button> : null}
                </div>
                {consumersByArtifact[artifact.id] ? <ul className="compact-list" aria-label={`产物消费者：${artifact.id}`}>{consumersByArtifact[artifact.id].length > 0 ? consumersByArtifact[artifact.id].map((consumer) => <li key={consumer.id}>节点 {consumer.consumerNodeId} 使用于 Agent {consumer.agentJobId ?? "未绑定"}</li>) : <li>尚未被下游节点使用。</li>}</ul> : null}
              </article>;
            })}
          </div>
        </>
      ) : <p className="body-copy">当前筛选条件下没有产物。</p>}
      {effectivePreview ? <article className="gate-record" aria-label="产物预览"><div className="panel-heading"><strong>内容预览</strong><div className="status-group"><span className={`status-pill${effectivePreview.integrity === "changed" ? " status-blocked" : ""}`}>{effectivePreview.integrity === "changed" ? "文件内容已变更" : "内容与登记哈希一致"}</span><button type="button" className="quiet-button" aria-label="关闭产物预览" onClick={() => context ? setScopedPreview(null) : onClosePreview?.()}>关闭</button></div></div><dl className="facts"><div><dt>媒体类型</dt><dd>{effectivePreview.mediaType}</dd></div><div><dt>文件大小</dt><dd>{effectivePreview.sizeBytes} bytes</dd></div><div><dt>当前哈希</dt><dd>{effectivePreview.currentHash}</dd></div></dl>{effectivePreview.content === null ? <p className="body-copy">该产物为二进制内容，无法在工作台内直接展示。</p> : <pre className="terminal-readout" aria-label="产物内容预览">{effectivePreview.content}</pre>}{effectivePreview.truncated ? <p className="body-copy">预览已按安全上限截断。</p> : null}</article> : null}
      {effectiveComparison ? <article className="gate-record" aria-label="产物差异"><div className="panel-heading"><strong>产物差异</strong><span className="status-pill">{effectiveComparison.before.id} → {effectiveComparison.after.id}</span></div><pre className="terminal-readout" aria-label="产物差异内容">{diffArtifactText(effectiveComparison.before.content, effectiveComparison.after.content).map((line) => `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}`).join("\n")}</pre></article> : null}
    </section>
  );
}

function downloadTextFile(fileName: string, content: string, mediaType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
