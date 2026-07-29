import { useState } from "react";

import type {
  KnowledgeCandidate,
  KnowledgeDocument,
  KnowledgeDocumentReplay,
  KnowledgeSynthesis,
  KnowledgeSynthesisOutputEvent,
} from "../../app/runtimeClient";
import { diffArtifactText } from "../artifacts/artifactDiff";

type Props = {
  candidates: KnowledgeCandidate[];
  documents?: KnowledgeDocument[];
  syntheses?: KnowledgeSynthesis[];
  synthesisOutput?: KnowledgeSynthesisOutputEvent[];
  replay?: KnowledgeDocumentReplay | null;
  onCreate: (title: string, content: string, source: string) => void;
  onReview: (candidateId: string, decision: "approved" | "rejected") => void;
  onPublish: (candidateId: string) => void;
  onSynthesize?: (candidateId: string, provider: KnowledgeSynthesis["provider"]) => void;
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

export function KnowledgePage({
  candidates,
  documents = [],
  syntheses = [],
  synthesisOutput = [],
  replay = null,
  onCreate,
  onReview,
  onPublish,
  onSynthesize,
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
  const [source, setSource] = useState("");
  const [feedbackBySynthesisId, setFeedbackBySynthesisId] = useState<Record<string, string>>({});

  function createCandidate() {
    if (!title.trim() || !content.trim() || !source.trim()) {
      return;
    }
    onCreate(title.trim(), content.trim(), source.trim());
    setTitle("");
    setContent("");
    setSource("");
  }

  return (
    <section id="knowledge" className="panel" aria-labelledby="knowledge-title">
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
      <div className="form-grid">
        <label>
          知识标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          知识来源
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如 run:run-123" />
        </label>
        <label className="form-wide">
          知识内容
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button
          className="quiet-button"
          disabled={!title.trim() || !content.trim() || !source.trim()}
          onClick={createCandidate}
        >
          创建候选
        </button>
        {operationMessage ? <span className="status-pill">{operationMessage}</span> : null}
      </div>
      <div className="gate-stack" aria-label="知识候选">
        {candidates.map((candidate) => (
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
            onSynthesize={onSynthesize}
            onFeedbackSynthesis={onFeedbackSynthesis}
            onPublishSynthesis={onPublishSynthesis}
          />
        ))}
        {candidates.length === 0 ? <p className="body-copy">还没有待审核知识候选。</p> : null}
      </div>
      {documents.length > 0 ? (
        <div className="gate-stack" aria-label="已发布知识">
          {documents.map((document) => (
            <article key={document.id} className="gate-record">
              <div className="panel-heading">
                <strong>{document.title}</strong>
                <span className="status-pill">
                  {document.gitPublicationCount > 0 ? `已推送 ${document.gitPublicationCount} 次` : "已发布"}
                </span>
              </div>
              <dl className="facts">
                <div>
                  <dt>来源</dt>
                  <dd>{document.source}</dd>
                </div>
                <div>
                  <dt>发布时间</dt>
                  <dd>{document.publishedAt}</dd>
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
  onSynthesize?: Props["onSynthesize"];
  onFeedbackSynthesis?: Props["onFeedbackSynthesis"];
  onPublishSynthesis?: Props["onPublishSynthesis"];
};

function KnowledgeCandidateCard({
  candidate,
  syntheses,
  synthesisOutput,
  feedbackBySynthesisId,
  onFeedbackChange,
  onReview,
  onPublish,
  onSynthesize,
  onFeedbackSynthesis,
  onPublishSynthesis,
}: KnowledgeCandidateCardProps) {
  const latestSynthesis = syntheses[0] ?? null;
  const isSynthesisActive =
    latestSynthesis?.status === "QUEUED" || latestSynthesis?.status === "RUNNING";

  return (
    <article className="gate-record">
      <div className="panel-heading">
        <strong>{candidate.title}</strong>
        <span className="status-pill">{candidate.status}</span>
      </div>
      <p className="body-copy">{candidate.content}</p>
      <dl className="facts">
        <div>
          <dt>来源</dt>
          <dd>{candidate.source}</dd>
        </div>
        <div>
          <dt>审核意见</dt>
          <dd>{candidate.reviewComment ?? "尚未审核"}</dd>
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
            {onSynthesize ? (
              <button
                className="quiet-button"
                disabled={isSynthesisActive}
                onClick={() => onSynthesize(candidate.id, "codex")}
                aria-label={`开始 CLI 合成：${candidate.title}`}
              >
                {isSynthesisActive ? "CLI 合成进行中" : "开始 CLI 合成"}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {latestSynthesis ? (
        <section className="knowledge-synthesis" aria-label={`知识合成：${candidate.title}`}>
          <div className="panel-heading">
            <strong>CLI 合成稿</strong>
            <span className="status-pill">{latestSynthesis.status}</span>
          </div>
          {latestSynthesis.error ? <p className="body-copy">合成失败：{latestSynthesis.error}</p> : null}
          {synthesisOutput.some((event) => event.synthesisId === latestSynthesis.id) ? (
            <pre className="terminal-readout" aria-label={`合成实时输出：${candidate.title}`}>
              {synthesisOutput
                .filter((event) => event.synthesisId === latestSynthesis.id)
                .sort((left, right) => left.sequence - right.sequence)
                .map((event) => formatSynthesisOutput(event.payload))
                .join("\n")}
            </pre>
          ) : null}
          {latestSynthesis.summary ? (
            <pre className="terminal-readout" aria-label={`合成差异：${candidate.title}`}>
              {diffArtifactText(candidate.content, latestSynthesis.summary)
                .map((line) => `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}`)
                .join("\n")}
            </pre>
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

function formatSynthesisOutput(payload: Record<string, unknown>): string {
  const value = payload.text ?? payload.message ?? payload.summary ?? JSON.stringify(payload);
  return String(value);
}
