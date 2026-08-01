import { useState } from "react";

import type { ArtifactConsumer, ArtifactPreview, RuntimeWorkbenchState } from "../../app/runtimeClient";
import { diffArtifactText } from "./artifactDiff";

type Props = {
  state: RuntimeWorkbenchState | null;
  preview?: ArtifactPreview | null;
  onPreviewArtifact?: (artifactId: string) => void;
  onCompareArtifacts?: (beforeArtifactId: string, afterArtifactId: string) => void;
  onDownloadEvidencePackage?: () => void;
  onDownloadReport?: () => void;
  onConfirmArtifact?: (artifact: RuntimeWorkbenchState["artifacts"][number]) => void;
  onLoadArtifactConsumers?: (artifactId: string) => Promise<ArtifactConsumer[]>;
  comparison?: {
    before: { id: string; content: string };
    after: { id: string; content: string };
  } | null;
};

export function ArtifactsPage({
  state,
  preview = null,
  onPreviewArtifact,
  onCompareArtifacts,
  onDownloadEvidencePackage,
  onDownloadReport,
  onConfirmArtifact,
  onLoadArtifactConsumers,
  comparison = null,
}: Props) {
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
  const [beforeArtifactId, setBeforeArtifactId] = useState("");
  const [afterArtifactId, setAfterArtifactId] = useState("");
  const [consumersByArtifact, setConsumersByArtifact] = useState<Record<string, ArtifactConsumer[]>>({});

  return (
    <section id="artifacts" className="panel" aria-labelledby="artifacts-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Evidence</p>
          <h2 id="artifacts-title">产物</h2>
        </div>
        <span className="status-pill">{artifacts.length > 0 ? "已索引" : "等待产物"}</span>
      </div>
      <p className="body-copy">
        Runtime 保护的产物记录。每次提交都会经过项目路径限制并记录内容哈希，供审批、门禁和审计引用。
      </p>
      {onDownloadEvidencePackage || onDownloadReport ? (
        <div className="button-row" aria-label="证据导出">
          {onDownloadEvidencePackage ? (
            <button className="quiet-button" onClick={onDownloadEvidencePackage}>
              下载证据包
            </button>
          ) : null}
          {onDownloadReport ? (
            <button className="quiet-button" onClick={onDownloadReport}>
              下载运行报告
            </button>
          ) : null}
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <>
          {onCompareArtifacts ? (
            <div className="gate-record" aria-label="产物比较">
              <div className="panel-heading">
                <strong>文本差异比较</strong>
                <span className="status-pill">Runtime 预览</span>
              </div>
              <div className="button-row">
                <label>
                  基准产物
                  <select
                    aria-label="基准产物"
                    value={beforeArtifactId}
                    onChange={(event) => setBeforeArtifactId(event.target.value)}
                  >
                    <option value="">选择基准</option>
                    {artifacts.map((artifact) => (
                      <option key={artifact.id} value={artifact.id}>
                        {artifact.type} · {artifact.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  对比产物
                  <select
                    aria-label="对比产物"
                    value={afterArtifactId}
                    onChange={(event) => setAfterArtifactId(event.target.value)}
                  >
                    <option value="">选择对比项</option>
                    {artifacts.map((artifact) => (
                      <option key={artifact.id} value={artifact.id}>
                        {artifact.type} · {artifact.id}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="quiet-button"
                  disabled={!beforeArtifactId || !afterArtifactId || beforeArtifactId === afterArtifactId}
                  onClick={() => onCompareArtifacts(beforeArtifactId, afterArtifactId)}
                >
                  比较产物
                </button>
              </div>
            </div>
          ) : null}
          <div className="gate-stack" aria-label="产物记录">
            {artifacts.map((artifact) => (
              <article key={artifact.id} className="gate-record">
                <div className="panel-heading">
                  <strong>{artifact.type}</strong>
                  <span className={`status-pill${artifact.status === "invalidated" ? " status-blocked" : ""}`}>
                    {artifact.status === "invalidated" ? "已失效" : artifact.status === "provisional" ? "待确认" : "已校验"}
                  </span>
                </div>
                <dl className="facts">
                  <div>
                    <dt>产物标识</dt>
                    <dd>{artifact.id}</dd>
                  </div>
                  <div>
                    <dt>安全位置</dt>
                    <dd>{artifact.relativePath ?? artifact.uri}</dd>
                  </div>
                  {artifact.artifactSpecId ? (
                    <div>
                      <dt>交付物规范</dt>
                      <dd>{artifact.artifactSpecId}</dd>
                    </div>
                  ) : null}
                  {artifact.supersedesArtifactId ? (
                    <div>
                      <dt>替代版本</dt>
                      <dd>{artifact.supersedesArtifactId}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>内容哈希</dt>
                    <dd>{artifact.contentHash}</dd>
                  </div>
                </dl>
                <div className="button-row">
                  <button className="quiet-button" onClick={() => onPreviewArtifact?.(artifact.id)}>
                    查看内容
                  </button>
                  {artifact.status === "provisional" ? (
                    <button className="quiet-button" onClick={() => onConfirmArtifact?.(artifact)}>
                      确认正式产物
                    </button>
                  ) : null}
                  {onLoadArtifactConsumers ? (
                    <button
                      className="quiet-button"
                      onClick={() => {
                        void onLoadArtifactConsumers(artifact.id).then((consumers) => {
                          setConsumersByArtifact((current) => ({ ...current, [artifact.id]: consumers }));
                        });
                      }}
                    >
                      查看使用记录
                    </button>
                  ) : null}
                </div>
                {consumersByArtifact[artifact.id] ? (
                  <ul className="compact-list" aria-label={`产物消费者：${artifact.id}`}>
                    {consumersByArtifact[artifact.id].length > 0 ? consumersByArtifact[artifact.id].map((consumer) => (
                      <li key={consumer.id}>
                        节点 {consumer.consumerNodeId} 使用于 Agent {consumer.agentJobId ?? "未绑定"}
                      </li>
                    )) : <li>尚未被下游节点使用。</li>}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="body-copy">当前 Run 还没有已验证的 Artifact 或 Evidence。</p>
      )}
      {preview ? (
        <article className="gate-record" aria-label="产物预览">
          <div className="panel-heading">
            <strong>内容预览</strong>
            <span className={`status-pill${preview.integrity === "changed" ? " status-blocked" : ""}`}>
              {preview.integrity === "changed" ? "文件内容已变更" : "内容与登记哈希一致"}
            </span>
          </div>
          <dl className="facts">
            <div>
              <dt>媒体类型</dt>
              <dd>{preview.mediaType}</dd>
            </div>
            <div>
              <dt>文件大小</dt>
              <dd>{preview.sizeBytes} bytes</dd>
            </div>
            <div>
              <dt>当前哈希</dt>
              <dd>{preview.currentHash}</dd>
            </div>
          </dl>
          {preview.content === null ? (
            <p className="body-copy">该产物为二进制内容，无法在工作台内直接展示。</p>
          ) : (
            <pre className="terminal-readout" aria-label="产物内容预览">
              {preview.content}
            </pre>
          )}
          {preview.truncated ? <p className="body-copy">预览已按安全上限截断。</p> : null}
        </article>
      ) : null}
      {comparison ? (
        <article className="gate-record" aria-label="产物差异">
          <div className="panel-heading">
            <strong>产物差异</strong>
            <span className="status-pill">
              {comparison.before.id} → {comparison.after.id}
            </span>
          </div>
          <pre className="terminal-readout" aria-label="产物差异内容">
            {diffArtifactText(comparison.before.content, comparison.after.content)
              .map((line) => `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}`)
              .join("\n")}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
