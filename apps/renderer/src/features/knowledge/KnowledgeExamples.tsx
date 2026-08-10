import { useEffect, useState } from "react";

import { RuntimeClientError, type KnowledgeClient } from "./knowledgeClient";

type Props = {
  client: KnowledgeClient;
};

export function KnowledgeExamples({ client }: Props) {
  const [examples, setExamples] = useState<Array<{ id: string; name: string; description: string; modes: string[] }>>([]);
  const [exampleId, setExampleId] = useState("");
  const [mode, setMode] = useState<"complete" | "template">("complete");
  const [targetPath, setTargetPath] = useState("");
  const [initializeGit, setInitializeGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listExamples()
      .then((response) => {
        if (!cancelled) {
          setExamples(response.items);
          if (response.items[0]) setExampleId(response.items[0].id);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const handleInitialize = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await client.initializeExample(exampleId, {
        mode,
        targetPath,
        initializeGit,
        actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
        now: new Date().toISOString(),
      });
      setMessage(
        `初始化完成：${result.rootPath}（${result.createdFiles.length} 个文件，Git：${result.gitInitialized ? "已初始化" : "未初始化"}）`,
      );
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="knowledge-examples">
      <div className="knowledge-detail-header">
        <h2>内置示例包</h2>
        <span className="knowledge-meta">初始化后仍需通过普通导入流程绑定</span>
      </div>
      {message ? <p className="knowledge-toast knowledge-toast--success">{message}</p> : null}
      {error ? <p className="knowledge-toast knowledge-toast--error">{error}</p> : null}

      <div className="knowledge-card-grid">
        {examples.map((example) => (
          <article key={example.id} className="knowledge-card">
            <div className="knowledge-card__head">
              <span className="knowledge-card__title">{example.name}</span>
              <span className="knowledge-badge">内置</span>
            </div>
            <p className="knowledge-meta" style={{ margin: 0 }}>{example.description}</p>
            <div className="knowledge-chip-list">
              {example.modes.map((item) => (
                <span key={item} className="knowledge-chip">{item === "complete" ? "完整示例" : "纯模板"}</span>
              ))}
            </div>
          </article>
        ))}
      </div>

      <section className="knowledge-section">
        <h3>初始化到本地目录</h3>
        <div className="knowledge-stacked-form">
          <label>
            模式
            <select value={mode} onChange={(event) => setMode(event.target.value as "complete" | "template")}>
              <option value="complete">完整示例（含虚构业务案例）</option>
              <option value="template">纯模板（只保留规则/目录/模板）</option>
            </select>
          </label>
          <label>
            目标目录
            <input
              type="text"
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
              placeholder="目标目录（必须不存在或为空）"
            />
          </label>
          <label className="inline-toggle">
            <input type="checkbox" checked={initializeGit} onChange={(event) => setInitializeGit(event.target.checked)} />
            初始化 Git 仓库
          </label>
        </div>
        <div className="button-row" style={{ marginTop: 16, marginBottom: 0 }}>
          <button
            type="button"
            className="knowledge-button--primary"
            disabled={busy || !targetPath.trim()}
            onClick={() => void handleInitialize()}
          >
            {busy ? "初始化中…" : "初始化示例"}
          </button>
        </div>
      </section>
    </div>
  );
}
