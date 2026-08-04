import { useState, type ReactNode } from "react";

import type {
  KnowledgeCandidate,
  KnowledgeDocument,
  KnowledgeDocumentReplay,
  KnowledgeSynthesis,
  KnowledgeSynthesisOutputEvent,
  RunSummary,
} from "../../app/runtimeClient";
import { diffArtifactText } from "../artifacts/artifactDiff";

type Props = {
  candidates: KnowledgeCandidate[];
  documents?: KnowledgeDocument[];
  syntheses?: KnowledgeSynthesis[];
  synthesisOutput?: KnowledgeSynthesisOutputEvent[];
  replay?: KnowledgeDocumentReplay | null;
  runs?: RunSummary[];
  activeRunId?: string | null;
  onCreate: (title: string, content: string, source: string) => void;
  onReview: (candidateId: string, decision: "approved" | "rejected") => void;
  onPublish: (candidateId: string) => void;
  onFeedbackSynthesis?: (synthesisId: string, feedback: string) => void;
  onPublishSynthesis?: (synthesisId: string) => void;
  onReplay?: (documentId: string) => void;
  onPreviewGit?: (documentId: string) => void;
  onPublishGit?: (documentId: string) => void;
  gitAvailable?: boolean;
  publishingDocumentId?: string | null;
  gitPreview?: {
    documentId: string;
    title: string;
    relativePath: string;
    previousContent: string;
    nextContent: string;
  } | null;
  operationMessage?: string;
};

type SynthesisViewer = {
  title: string;
  label: string;
  kind: "log" | "rich";
  content: string;
} | null;

export function KnowledgePage({
  candidates,
  documents = [],
  syntheses = [],
  synthesisOutput = [],
  replay = null,
  runs = [],
  activeRunId = null,
  onCreate,
  onReview,
  onPublish,
  onFeedbackSynthesis,
  onPublishSynthesis,
  onReplay,
  onPreviewGit,
  onPublishGit,
  gitAvailable = false,
  publishingDocumentId = null,
  gitPreview = null,
  operationMessage,
}: Props) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [feedbackBySynthesisId, setFeedbackBySynthesisId] = useState<Record<string, string>>({});
  const [synthesisViewer, setSynthesisViewer] = useState<SynthesisViewer>(null);

  function createCandidate() {
    const runId = selectedRunId || activeRunId || runs[0]?.id;
    if (!title.trim() || !content.trim() || !runId) {
      return;
    }
    onCreate(title.trim(), content.trim(), `run:${runId}`);
    setTitle("");
    setContent("");
  }

  const effectiveRunId = selectedRunId || activeRunId || runs[0]?.id || "";
  const sortedCandidates = [...candidates].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const sortedDocuments = [...documents].sort((left, right) =>
    Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
  );

  return (
    <section id="knowledge" className="panel page-workspace page-knowledge" aria-labelledby="knowledge-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Knowledge</p>
          <h2 id="knowledge-title">知识库</h2>
        </div>
        <span className="status-pill">{candidates.length} 个候选</span>
      </div>
      <p className="body-copy">
        知识必须经过可信人工审核后才能发布。发布记录会写入 Runtime 审计链，供后续检索和复盘。
      </p>
      <details className="knowledge-manual-entry">
        <summary>补录人工知识</summary>
        <p className="body-copy">用于记录无法从 Run 产物直接提炼的经验、规则或临时决策。</p>
      <div className="form-grid">
        <label>
          关联 Run
          <select
            aria-label="关联 Run"
            value={effectiveRunId}
            onChange={(event) => setSelectedRunId(event.target.value)}
            disabled={runs.length === 0}
          >
            {runs.length === 0 ? <option value="">当前项目没有可关联的 Run</option> : null}
            {runs.map((run) => <option key={run.id} value={run.id}>{run.title} ({run.status})</option>)}
          </select>
        </label>
        <label>
          知识标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="form-wide">
          知识内容
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button
          className="quiet-button"
          disabled={!title.trim() || !content.trim() || !effectiveRunId}
          onClick={createCandidate}
        >
          创建候选
        </button>
        {operationMessage ? <span className="status-pill">{operationMessage}</span> : null}
      </div>
      </details>
      <div className="gate-stack" aria-label="知识候选">
        {sortedCandidates.map((candidate) => (
          <KnowledgeCandidateCard
            key={candidate.id}
            candidate={candidate}
            syntheses={syntheses.filter((synthesis) => synthesis.candidateId === candidate.id)}
            synthesisOutput={synthesisOutput}
            feedbackBySynthesisId={feedbackBySynthesisId}
            onFeedbackChange={(synthesisId, feedback) =>
              setFeedbackBySynthesisId((current) => ({ ...current, [synthesisId]: feedback }))
            }
            onReview={onReview}
            onPublish={onPublish}
            onFeedbackSynthesis={onFeedbackSynthesis}
            onPublishSynthesis={onPublishSynthesis}
            onOpenSynthesisViewer={(viewer) => setSynthesisViewer(viewer)}
          />
        ))}
        {candidates.length === 0 ? <p className="body-copy">还没有待审核知识候选。</p> : null}
      </div>
      {documents.length > 0 ? (
        <div className="gate-stack" aria-label="已发布知识">
          {sortedDocuments.map((document) => (
            <article key={document.id} className="gate-record">
              <div className="panel-heading">
                <strong>{document.title}</strong>
                <span className="status-pill">
                  {document.gitPublicationCount > 0 ? `已推送 ${document.gitPublicationCount} 次` : knowledgeStatusLabel(document.status)}
                </span>
              </div>
              <dl className="facts">
                <div>
                  <dt>来源</dt>
                  <dd>{document.source}</dd>
                </div>
                <div>
                  <dt>发布时间</dt>
                  <dd>{formatChinaTime(document.publishedAt)}</dd>
                </div>
                {document.latestGitPublication ? (
                  <div>
                    <dt>最近 Git 推送</dt>
                    <dd>
                      {document.latestGitPublication.branch} · {document.latestGitPublication.commitHash}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="button-row">
                {onReplay ? (
                  <button
                    className="quiet-button"
                    onClick={() => onReplay(document.id)}
                    aria-label={`回放发布记录：${document.title}`}
                  >
                    回放发布记录
                  </button>
                ) : null}
                {gitAvailable && onPreviewGit ? (
                  <button
                    className="quiet-button"
                    onClick={() => onPreviewGit(document.id)}
                    aria-label={`预览 Git 变更：${document.title}`}
                  >
                    预览 Git 变更
                  </button>
                ) : null}
                {gitAvailable && onPublishGit && document.gitPublicationCount === 0 ? (
                  <button
                    className="quiet-button"
                    disabled={publishingDocumentId === document.id}
                    onClick={() => onPublishGit(document.id)}
                    aria-label={`提交并推送知识：${document.title}`}
                  >
                    {publishingDocumentId === document.id ? "正在提交并推送" : "提交并推送知识"}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {gitPreview ? (
        <article className="gate-record" aria-label="知识 Git 变更预览">
          <div className="panel-heading">
            <strong>知识 Git 变更预览</strong>
            <span className="status-pill">{gitPreview.relativePath}</span>
          </div>
          <pre className="terminal-readout" aria-label="知识 Git 差异内容">
            {diffArtifactText(gitPreview.previousContent, gitPreview.nextContent)
              .map((line) => `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}`)
              .join("\n")}
          </pre>
        </article>
      ) : null}
      {replay ? (
        <article className="gate-record" aria-label="知识发布回放">
          <div className="panel-heading">
            <strong>知识发布回放</strong>
            <span className="status-pill">{replay.document.status}</span>
          </div>
          <dl className="facts">
            <div>
              <dt>文档</dt>
              <dd>{replay.document.title}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{replay.candidate.source}</dd>
            </div>
            <div>
              <dt>审核意见</dt>
              <dd>{replay.candidate.reviewComment ?? "无"}</dd>
            </div>
          </dl>
          <ul className="compact-list" aria-label="知识审计时间线">
            {replay.auditRecords.map((record) => (
              <li key={record.id}>
                {record.createdAt} · {record.action} · {record.actor.id}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
      {synthesisViewer ? (
        <div className="knowledge-drawer-backdrop" role="presentation">
          <section
            className="knowledge-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-viewer-title"
          >
            <div className="panel-heading">
              <div>
                <p className="section-kicker">{synthesisViewer.label}</p>
                <h3 id="knowledge-viewer-title">{synthesisViewer.title}</h3>
              </div>
              <button className="quiet-button" onClick={() => setSynthesisViewer(null)}>
                关闭
              </button>
            </div>
            {synthesisViewer.kind === "log" ? (
              <pre className="terminal-readout" aria-label={`${synthesisViewer.label}：${synthesisViewer.title}`}>
                {synthesisViewer.content}
              </pre>
            ) : (
              <RichTextPreview
                ariaLabel={`${synthesisViewer.label}：${synthesisViewer.title}`}
                content={synthesisViewer.content}
              />
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

type KnowledgeCandidateCardProps = {
  candidate: KnowledgeCandidate;
  syntheses: KnowledgeSynthesis[];
  synthesisOutput: KnowledgeSynthesisOutputEvent[];
  feedbackBySynthesisId: Record<string, string>;
  onFeedbackChange: (synthesisId: string, feedback: string) => void;
  onReview: Props["onReview"];
  onPublish: Props["onPublish"];
  onFeedbackSynthesis?: Props["onFeedbackSynthesis"];
  onPublishSynthesis?: Props["onPublishSynthesis"];
  onOpenSynthesisViewer: (viewer: Exclude<SynthesisViewer, null>) => void;
};

function KnowledgeCandidateCard({
  candidate,
  syntheses,
  synthesisOutput,
  feedbackBySynthesisId,
  onFeedbackChange,
  onReview,
  onPublish,
  onFeedbackSynthesis,
  onPublishSynthesis,
  onOpenSynthesisViewer,
}: KnowledgeCandidateCardProps) {
  const latestSynthesis = syntheses[0] ?? null;
  return (
    <article className="gate-record">
      <div className="panel-heading">
        <strong>{candidate.title}</strong>
        <span className="status-pill">{knowledgeStatusLabel(candidate.status)}</span>
      </div>
      <details>
        <summary>查看知识正文</summary>
        <p className="body-copy">{candidate.content}</p>
      </details>
      <dl className="facts">
        <div>
          <dt>来源</dt>
          <dd>{candidate.source}</dd>
        </div>
        <div>
          <dt>审核意见</dt>
          <dd>{candidate.reviewComment ?? "尚未审核"}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatChinaTime(candidate.createdAt)}</dd>
        </div>
      </dl>
      <div className="button-row">
        {candidate.status === "pending" ? (
          <>
            <button className="quiet-button" onClick={() => onReview(candidate.id, "approved")}>
              批准候选
            </button>
            <button className="quiet-button" onClick={() => onReview(candidate.id, "rejected")}>
              拒绝候选
            </button>
          </>
        ) : null}
        {candidate.status === "approved" && !candidate.publishedAt ? (
          <>
            <button className="quiet-button" onClick={() => onPublish(candidate.id)}>
              发布知识
            </button>
          </>
        ) : null}
      </div>
      {latestSynthesis ? (
        <section className="knowledge-synthesis" aria-label={`知识合成：${candidate.title}`}>
          <div className="panel-heading">
            <strong>CLI 合成稿</strong>
            <span className="status-pill">{knowledgeStatusLabel(latestSynthesis.status)}</span>
          </div>
          {latestSynthesis.error ? <p className="body-copy">合成失败：{latestSynthesis.error}</p> : null}
          {synthesisOutput.some((event) => event.synthesisId === latestSynthesis.id) ? (
            <button
              className="knowledge-detail-trigger"
              onClick={() =>
                onOpenSynthesisViewer({
                  title: candidate.title,
                  label: "CLI 执行日志",
                  kind: "log",
                  content: synthesisOutput
                    .filter((event) => event.synthesisId === latestSynthesis.id)
                    .sort((left, right) => left.sequence - right.sequence)
                    .map((event) => formatSynthesisOutput(event.payload))
                    .join("\n"),
                })
              }
            >
              查看 CLI 执行日志
            </button>
          ) : null}
          {latestSynthesis.summary ? (
            <button
              className="knowledge-detail-trigger"
              onClick={() =>
                onOpenSynthesisViewer({
                  title: candidate.title,
                  label: "合成结果",
                  kind: "rich",
                  content: latestSynthesis.summary ?? "",
                })
              }
            >
              查看合成结果
            </button>
          ) : (
            <p className="body-copy">正在等待 CLI 返回合成结果。</p>
          )}
          <label className="form-wide">
            合成反馈
            <textarea
              aria-label={`合成反馈：${candidate.title}`}
              value={feedbackBySynthesisId[latestSynthesis.id] ?? latestSynthesis.feedback ?? ""}
              onChange={(event) => onFeedbackChange(latestSynthesis.id, event.target.value)}
            />
          </label>
          <div className="button-row">
            {onFeedbackSynthesis ? (
              <button
                className="quiet-button"
                disabled={!(feedbackBySynthesisId[latestSynthesis.id] ?? latestSynthesis.feedback ?? "").trim()}
                onClick={() =>
                  onFeedbackSynthesis(
                    latestSynthesis.id,
                    (feedbackBySynthesisId[latestSynthesis.id] ?? latestSynthesis.feedback ?? "").trim(),
                  )
                }
                aria-label={`保存合成反馈：${candidate.title}`}
              >
                保存合成反馈
              </button>
            ) : null}
            {latestSynthesis.status === "COMPLETED" &&
            latestSynthesis.summary &&
            onPublishSynthesis ? (
              <button
                className="quiet-button"
                onClick={() => onPublishSynthesis(latestSynthesis.id)}
                aria-label={`发布合成稿：${candidate.title}`}
              >
                发布合成稿
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </article>
  );
}

function RichTextPreview({ content, ariaLabel }: { content: string; ariaLabel: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let inCode = false;
  let codeLines: string[] = [];
  const blocks: ReactNode[] = [];

  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        blocks.push(<pre className="rich-text-code" key={`code-${index}`}>{codeLines.join("\n")}</pre>);
        codeLines = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    if (!line.trim()) {
      blocks.push(<div className="rich-text-spacer" key={`space-${index}`} />);
      return;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const Heading = `h${Math.min(6, heading[1].length)}` as keyof JSX.IntrinsicElements;
      blocks.push(<Heading key={`heading-${index}`}>{renderInlineText(heading[2])}</Heading>);
      return;
    }
    if (/^[-*]\s+/.test(line.trim())) {
      blocks.push(<li key={`item-${index}`}>{renderInlineText(line.trim().slice(2))}</li>);
      return;
    }
    blocks.push(<p key={`paragraph-${index}`}>{renderInlineText(line)}</p>);
  });

  if (inCode && codeLines.length > 0) {
    blocks.push(<pre className="rich-text-code" key="code-final">{codeLines.join("\n")}</pre>);
  }

  return <article className="rich-text-preview" aria-label={ariaLabel}>{blocks}</article>;
}

function renderInlineText(value: string): ReactNode {
  return value.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

function formatSynthesisOutput(payload: Record<string, unknown>): string {
  const value = payload.text ?? payload.message ?? payload.summary ?? JSON.stringify(payload);
  return String(value);
}

function formatChinaTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function knowledgeStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待审核";
    case "approved":
      return "已通过";
    case "rejected":
      return "已拒绝";
    case "QUEUED":
      return "等待合成";
    case "RUNNING":
      return "正在合成";
    case "COMPLETED":
      return "合成完成";
    case "FAILED":
      return "合成失败";
    case "published":
      return "已发布";
    default:
      return status;
  }
}
