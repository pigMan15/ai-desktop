import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  KnowledgeCandidate,
  KnowledgeDocument,
  KnowledgeDocumentReplay,
  KnowledgeSynthesis,
  KnowledgeSynthesisOutputEvent,
  RunSummary,
} from "../../app/runtimeClient";
import { ChangeSetCreate } from "./ChangeSetCreate";
import { ChangeSetDetail } from "./ChangeSetDetail";
import { KnowledgeExamples } from "./KnowledgeExamples";
import { LegacyKnowledgePanel } from "./LegacyKnowledgePanel";
import { RepositoryDetail } from "./RepositoryDetail";
import { RepositoryList } from "./RepositoryList";
import { createKnowledgeClient, type KnowledgeClient } from "./knowledgeClient";

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
  apiBaseUrl?: string;
};

type KnowledgeSubRoute =
  | { mode: "repositories" }
  | { mode: "repository"; repositoryId: string }
  | { mode: "change-sets-new"; projectId: string; runId: string }
  | { mode: "change-set"; projectId: string; runId: string; changeSetId: string }
  | { mode: "examples" }
  | { mode: "legacy" }
  | { mode: "none" };

function parseKnowledgeSubRoute(hash: string): KnowledgeSubRoute {
  const pathname = hash.split("?")[0];
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  if (pathname === "#/knowledge" || pathname === "#/knowledge/") return { mode: "legacy" };
  if (pathname === "#/knowledge/repositories") return { mode: "repositories" };
  if (pathname === "#/knowledge/examples") return { mode: "examples" };
  if (pathname === "#/knowledge/change-sets/new") {
    const projectId = params.get("projectId") ?? "";
    const runId = params.get("runId") ?? "";
    return projectId && runId ? { mode: "change-sets-new", projectId, runId } : { mode: "legacy" };
  }
  const repositoryMatch = pathname.match(/^#\/knowledge\/repositories\/([^/]+)$/);
  if (repositoryMatch) {
    try {
      return { mode: "repository", repositoryId: decodeURIComponent(repositoryMatch[1]) };
    } catch {
      return { mode: "legacy" };
    }
  }
  const changeSetMatch = pathname.match(/^#\/knowledge\/change-sets\/([^/]+)$/);
  if (changeSetMatch) {
    const projectId = params.get("projectId") ?? "";
    const runId = params.get("runId") ?? "";
    if (!projectId || !runId) return { mode: "legacy" };
    try {
      return {
        mode: "change-set",
        projectId,
        runId,
        changeSetId: decodeURIComponent(changeSetMatch[1]),
      };
    } catch {
      return { mode: "legacy" };
    }
  }
  return { mode: "none" };
}

export function KnowledgePage({
  candidates,
  documents = [],
  syntheses = [],
  onCreate,
  onReview,
  onPublish,
  onPublishSynthesis,
  apiBaseUrl,
  ...legacyProps
}: Props) {
  const client: KnowledgeClient | null = useMemo(
    () => (apiBaseUrl ? createKnowledgeClient(apiBaseUrl) : null),
    [apiBaseUrl],
  );
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const listener = () => setHash(window.location.hash);
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);

  const navigate = useCallback((nextHash: string) => {
    window.location.hash = nextHash;
    setHash(nextHash);
  }, []);

  const subRoute = parseKnowledgeSubRoute(hash);
  const artifacts = legacyProps.runs?.length ? [] : [];
  const effectiveRoute = subRoute.mode === "none" ? { mode: "legacy" as const } : subRoute;
  const repositoryTabActive = [
    "repositories",
    "repository",
    "change-sets-new",
    "change-set",
  ].includes(effectiveRoute.mode);

  return (
    <div className="knowledge-workbench">
      {client ? (
        <nav className="knowledge-tabs" aria-label="知识库导航">
          <button type="button" className={repositoryTabActive ? "active" : ""} onClick={() => navigate("#/knowledge/repositories")}>
            仓库
          </button>
          <button type="button" className={effectiveRoute.mode === "examples" ? "active" : ""} onClick={() => navigate("#/knowledge/examples")}>
            示例包
          </button>
          <button type="button" className={effectiveRoute.mode === "legacy" ? "active" : ""} onClick={() => navigate("#/knowledge/legacy")}>
            旧面板
          </button>
        </nav>
      ) : null}
      {client && effectiveRoute.mode === "repositories" ? <RepositoryList client={client} onNavigate={navigate} /> : null}
      {client && effectiveRoute.mode === "repository" ? (
        <RepositoryDetail client={client} repositoryId={effectiveRoute.repositoryId} onNavigate={navigate} />
      ) : null}
      {client && effectiveRoute.mode === "examples" ? <KnowledgeExamples client={client} /> : null}
      {client && effectiveRoute.mode === "change-sets-new" ? (
        <ChangeSetCreate
          client={client}
          projectId={effectiveRoute.projectId}
          runId={effectiveRoute.runId}
          artifacts={artifacts}
          apiBaseUrl={apiBaseUrl}
          onNavigate={navigate}
        />
      ) : null}
      {client && effectiveRoute.mode === "change-set" ? (
        <ChangeSetDetail
          client={client}
          projectId={effectiveRoute.projectId}
          runId={effectiveRoute.runId}
          changeSetId={effectiveRoute.changeSetId}
          onNavigate={navigate}
        />
      ) : null}
      {effectiveRoute.mode === "legacy" || !client ? (
        <LegacyKnowledgePanel
          candidates={candidates}
          documents={documents}
          syntheses={syntheses}
          onCreate={onCreate}
          onReview={onReview}
          onPublish={onPublish}
          onPublishSynthesis={onPublishSynthesis}
          {...legacyProps}
        />
      ) : null}
      {client && effectiveRoute.mode === "repository" ? null : null}
    </div>
  );
}
