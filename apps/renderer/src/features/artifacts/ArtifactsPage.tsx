import { useMemo, useState } from "react";

import type {
  ArtifactConsumer,
  ArtifactPreview,
  KnowledgeSynthesis,
  RunSummary,
  RuntimeWorkbenchState,
} from "../../app/runtimeClient";
import { diffArtifactText } from "./artifactDiff";

type Artifact = RuntimeWorkbenchState["artifacts"][number];

type Props = {
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
  const artifacts = providedArtifacts ?? (Array.isArray(state?.artifacts) ? state.artifacts : []);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [provider, setProvider] = useState<KnowledgeSynthesis["provider"]>("codex");
  const [beforeArtifactId, setBeforeArtifactId] = useState("");
  const [afterArtifactId, setAfterArtifactId] = useState("");
  const [consumersByArtifact, setConsumersByArtifact] = useState<Record<string, ArtifactConsumer[]>>({});

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
      {onDownloadEvidencePackage || onDownloadReport ? (
        <div className="button-row" aria-label="证据导出">
          {onDownloadEvidencePackage ? <button className="quiet-button" onClick={onDownloadEvidencePackage}>下载证据包</button> : null}
          {onDownloadReport ? <button className="quiet-button" onClick={onDownloadReport}>下载运行报告</button> : null}
        </div>
      ) : null}
      {visibleArtifacts.length > 0 ? (
        <>
          {onCompareArtifacts ? (
            <div className="gate-record" aria-label="产物比较">
              <div className="panel-heading"><strong>文本差异比较</strong><span className="status-pill">Runtime 预览</span></div>
              <div className="button-row">
                <label>基准产物<select aria-label="基准产物" value={beforeArtifactId} onChange={(event) => setBeforeArtifactId(event.target.value)}><option value="">选择基准</option>{visibleArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.type} · {artifact.id}</option>)}</select></label>
                <label>对比产物<select aria-label="对比产物" value={afterArtifactId} onChange={(event) => setAfterArtifactId(event.target.value)}><option value="">选择对比项</option>{visibleArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.type} · {artifact.id}</option>)}</select></label>
                <button className="quiet-button" disabled={!beforeArtifactId || !afterArtifactId || beforeArtifactId === afterArtifactId} onClick={() => {
                  const before = artifactById.get(beforeArtifactId);
                  const after = artifactById.get(afterArtifactId);
                  if (before?.runId && after?.runId) onCompareArtifacts(before.runId, before.id, after.runId, after.id);
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
                  <button className="quiet-button" onClick={() => artifact.runId && onPreviewArtifact?.(artifact.runId, artifact.id)}>查看内容</button>
                  {artifact.status === "provisional" ? <button className="quiet-button" onClick={() => artifact.runId && onConfirmArtifact?.(artifact.runId, artifact)}>确认为正式产物</button> : null}
                  {onLoadArtifactConsumers ? <button className="quiet-button" onClick={() => {
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
      {preview ? <article className="gate-record" aria-label="产物预览"><div className="panel-heading"><strong>内容预览</strong><div className="status-group"><span className={`status-pill${preview.integrity === "changed" ? " status-blocked" : ""}`}>{preview.integrity === "changed" ? "文件内容已变更" : "内容与登记哈希一致"}</span><button type="button" className="quiet-button" aria-label="关闭产物预览" onClick={onClosePreview}>关闭</button></div></div><dl className="facts"><div><dt>媒体类型</dt><dd>{preview.mediaType}</dd></div><div><dt>文件大小</dt><dd>{preview.sizeBytes} bytes</dd></div><div><dt>当前哈希</dt><dd>{preview.currentHash}</dd></div></dl>{preview.content === null ? <p className="body-copy">该产物为二进制内容，无法在工作台内直接展示。</p> : <pre className="terminal-readout" aria-label="产物内容预览">{preview.content}</pre>}{preview.truncated ? <p className="body-copy">预览已按安全上限截断。</p> : null}</article> : null}
      {comparison ? <article className="gate-record" aria-label="产物差异"><div className="panel-heading"><strong>产物差异</strong><span className="status-pill">{comparison.before.id} → {comparison.after.id}</span></div><pre className="terminal-readout" aria-label="产物差异内容">{diffArtifactText(comparison.before.content, comparison.after.content).map((line) => `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}`).join("\n")}</pre></article> : null}
    </section>
  );
}
