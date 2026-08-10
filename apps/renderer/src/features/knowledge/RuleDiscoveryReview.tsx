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
  const [acknowledged, setAcknowledged] = useState(false);
  const disabled = busy || (openQuestions.length > 0 && !acknowledged);

  const confirmSummary = () => {
    const base = summary.trim();
    if (openQuestions.length === 0) return base;
    const recorded = [
      `（确认时已知悉 ${openQuestions.length} 项待确认事项）`,
      ...openQuestions.map((question) => `- ${question}`),
    ].join("\n");
    return base ? `${base}\n\n${recorded}` : recorded;
  };

  return (
    <section className="knowledge-section">
      <h3>规则发现报告</h3>
      {openQuestions.length > 0 ? (
        <div className="knowledge-toast knowledge-toast--warning" style={{ marginBottom: 14 }}>
          <strong>发现 {openQuestions.length} 个待确认项</strong>
          <p style={{ margin: "6px 0 8px" }}>
            待确认项表示仓库文档中存在不一致或未定义的事项，不会阻断规则扫描，但需要你决策：
          </p>
          <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
            {openQuestions.map((question) => (
              <li key={question} style={{ marginBottom: 6 }}>
                {question}
              </li>
            ))}
          </ul>
          <p style={{ margin: 0 }}>
            处理方式：① 修改仓库文档后重新执行规则发现，可消除待确认项；② 逐条阅读后勾选下方确认框，
            将待确认项记录在快照中并继续确认（不会自动修改仓库）。
          </p>
        </div>
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

      {openQuestions.length > 0 ? (
        <label className="knowledge-check" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            我已逐条阅读以上 {openQuestions.length} 项待确认事项，了解其含义与风险，仍要确认（确认后会记录在快照摘要中）
          </span>
        </label>
      ) : null}

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
              summary: confirmSummary(),
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
