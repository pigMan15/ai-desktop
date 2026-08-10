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
    <div className="rule-discovery-review">
      <h3>规则发现报告</h3>
      {openQuestions.length > 0 ? (
        <p className="operation-error">存在未确定项，必须先解决才能确认：{openQuestions.join("；")}</p>
      ) : null}
      <h4>发现的规则文件</h4>
      <ul>
        {discoveredFiles.map((file) => (
          <li key={file.path}>
            {file.path}（{file.category}）
          </li>
        ))}
      </ul>
      <label>
        可写目录（每行一个）
        <textarea value={writablePathsText} onChange={(event) => setWritablePathsText(event.target.value)} rows={4} />
      </label>
      <label>
        保护目录（每行一个）
        <textarea value={protectedPathsText} onChange={(event) => setProtectedPathsText(event.target.value)} rows={4} />
      </label>
      <label>
        摘要
        <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} />
      </label>
      <div className="button-row">
        <button
          type="button"
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
          确认规则
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      <p className="muted">确认后仓库 revision 将推进（当前 {expectedRevision}）。</p>
    </div>
  );
}
