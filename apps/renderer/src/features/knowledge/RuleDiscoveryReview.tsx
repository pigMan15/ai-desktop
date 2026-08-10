import { useState } from "react";

import type { KnowledgeRuleSnapshotSummary } from "./knowledgeClient";

type Props = {
  snapshot: KnowledgeRuleSnapshotSummary;
  expectedRevision: string;
  busy: boolean;
  onConfirm: (payload: {
    writablePaths: string[];
    protectedPaths: string[];
    indexFiles: string[];
    routingFiles: string[];
    templateFiles: string[];
    validationCommands: string[];
    summary: string;
    openQuestions: string[];
  }) => void;
  onCancel: () => void;
};

export function RuleDiscoveryReview({ snapshot, expectedRevision, busy, onConfirm, onCancel }: Props) {
  const discoveredFiles = snapshot.discoveredFiles ?? [];
  const openQuestions = snapshot.openQuestions ?? [];
  const writablePaths = snapshot.writablePaths ?? [];
  const protectedPaths = snapshot.protectedPaths ?? [];
  const [writablePathsText, setWritablePathsText] = useState(writablePaths.join("\n"));
  const [protectedPathsText, setProtectedPathsText] = useState(protectedPaths.join("\n"));
  const [summary, setSummary] = useState(snapshot.summary ?? "");
  const disabled = busy || openQuestions.length > 0;

  return (
    <section className="knowledge-section">
      <h3>规则发现报告</h3>
      {openQuestions.length > 0 ? (
        <p className="knowledge-toast knowledge-toast--error">
          存在未确定项，必须先解决才能确认：{openQuestions.join("；")}
        </p>
      ) : null}

      {discoveredFiles.length === 0 ? (
        <p className="knowledge-empty" style={{ minHeight: 70, marginBottom: 14 }}>
          未发现规则入口文件——请在下方向下确认最小可写边界，或先用示例包初始化规则。
        </p>
      ) : (
        <>
          <p className="knowledge-meta" style={{ marginBottom: 8 }}>发现的规则文件</p>
          <div className="knowledge-chip-list" style={{ marginBottom: 14 }}>
            {discoveredFiles.map((file) => (
              <span key={file.path} className="knowledge-chip">
                {file.path}
                <em>{file.category}</em>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="knowledge-stacked-form">
        <label>
          可写目录（每行一个，例如 candidate/**）
          <textarea
            value={writablePathsText}
            onChange={(event) => setWritablePathsText(event.target.value)}
            rows={4}
          />
        </label>
        <label>
          保护目录（每行一个，例如 .git/**）
          <textarea
            value={protectedPathsText}
            onChange={(event) => setProtectedPathsText(event.target.value)}
            rows={3}
          />
        </label>
        <label>
          规则摘要
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} />
        </label>
      </div>

      <div className="button-row" style={{ marginTop: 16, marginBottom: 0 }}>
        <button
          type="button"
          className="knowledge-button--primary"
          disabled={disabled}
          onClick={() =>
            onConfirm({
              writablePaths: writablePathsText.split("\n").map((item) => item.trim()).filter(Boolean),
              protectedPaths: protectedPathsText.split("\n").map((item) => item.trim()).filter(Boolean),
              indexFiles: snapshot.indexFiles ?? [],
              routingFiles: snapshot.routingFiles ?? [],
              templateFiles: snapshot.templateFiles ?? [],
              validationCommands: snapshot.validationCommands ?? [],
              summary: summary.trim(),
              openQuestions: [],
            })
          }
        >
          {busy ? "确认中…" : "确认规则"}
        </button>
        <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <span className="knowledge-meta">确认后仓库 revision 将推进（当前 {expectedRevision}）。</span>
      </div>
    </section>
  );
}
