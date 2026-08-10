import { useEffect, useState } from "react";

import { createRuntimeClient } from "../../app/runtimeClient";
import { RuntimeClientError, type KnowledgeClient } from "./knowledgeClient";

type ArtifactOption = { id: string; type: string };

type Props = {
  client: KnowledgeClient;
  projectId: string;
  runId: string;
  artifacts?: ArtifactOption[];
  apiBaseUrl?: string;
  onNavigate: (hash: string) => void;
};

export function ChangeSetCreate({ client, projectId, runId, artifacts = [], apiBaseUrl, onNavigate }: Props) {
  const [repositories, setRepositories] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [selectedArtifacts, setSelectedArtifacts] = useState<string[]>([]);
  const [provider, setProvider] = useState<"codex" | "claude" | "fake">("codex");
  const [mode, setMode] = useState<"preview" | "risk-based">("preview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listRepositories()
      .then((items) => {
        if (!cancelled) {
          setRepositories(items.filter((item) => item.status === "ACTIVE"));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const [loadedArtifacts, setLoadedArtifacts] = useState<ArtifactOption[] | null>(null);
  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;
    const runtimeClient = createRuntimeClient(apiBaseUrl);
    runtimeClient
      .listArtifacts(projectId, runId, new AbortController().signal)
      .then((items) => {
        if (!cancelled) {
          setLoadedArtifacts(
            items.map((artifact) => ({ id: artifact.id, type: artifact.type })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setLoadedArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, projectId, runId]);

  const toggleArtifact = (artifactId: string) => {
    setSelectedArtifacts((current) =>
      current.includes(artifactId) ? current.filter((id) => id !== artifactId) : [...current, artifactId],
    );
  };

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const changeSet = await client.createChangeSet(projectId, runId, {
        repositoryId,
        artifactIds: selectedArtifacts,
        provider,
        mode,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        now: new Date().toISOString(),
      });
      onNavigate(`#/knowledge/change-sets/${changeSet.id}?projectId=${projectId}&runId=${runId}`);
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="knowledge-change-set-create">
      <h2>创建知识变更集</h2>
      {error ? <p className="operation-error">{error}</p> : null}
      <label>
        目标知识库
        <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">选择仓库</option>
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>选择 Artifact（只读来源）</legend>
        {(loadedArtifacts ?? artifacts).map((artifact) => (
          <label key={artifact.id} className="artifact-option">
            <input
              type="checkbox"
              checked={selectedArtifacts.includes(artifact.id)}
              onChange={() => toggleArtifact(artifact.id)}
            />
            {artifact.id}（{artifact.type}）
          </label>
        ))}
        {(loadedArtifacts ?? artifacts).length === 0 ? <p className="muted">该 Run 暂无 Artifact</p> : null}
      </fieldset>
      <label>
        Provider
        <select value={provider} onChange={(event) => setProvider(event.target.value as "codex" | "claude" | "fake")}>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
          <option value="fake">Fake</option>
        </select>
      </label>
      <label>
        模式
        <select value={mode} onChange={(event) => setMode(event.target.value as "preview" | "risk-based")}>
          <option value="preview">预览（永不自动应用）</option>
          <option value="risk-based">风险分级</option>
        </select>
      </label>
      <button type="button" disabled={busy || !repositoryId || selectedArtifacts.length === 0} onClick={() => void handleCreate()}>
        创建变更集
      </button>
    </div>
  );
}
