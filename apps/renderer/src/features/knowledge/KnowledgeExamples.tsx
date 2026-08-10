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
      setMessage(`初始化完成：${result.rootPath}（${result.createdFiles.length} 个文件，Git：${result.gitInitialized ? "已初始化" : "未初始化"}）`);
    } catch (caught: unknown) {
      setError(caught instanceof RuntimeClientError ? caught.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="knowledge-examples">
      <h2>内置示例包</h2>
      {message ? <p className="operation-message">{message}</p> : null}
      {error ? <p className="operation-error">{error}</p> : null}
      {examples.map((example) => (
        <section key={example.id}>
          <h3>{example.name}</h3>
          <p>{example.description}</p>
        </section>
      ))}
      <label>
        示例
        <select value={exampleId} onChange={(event) => setExampleId(event.target.value)}>
          {examples.map((example) => (
            <option key={example.id} value={example.id}>
              {example.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        模式
        <select value={mode} onChange={(event) => setMode(event.target.value as "complete" | "template")}>
          <option value="complete">完整示例</option>
          <option value="template">纯模板</option>
        </select>
      </label>
      <label>
        目标目录
        <input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} placeholder="目标目录（必须不存在或为空）" />
      </label>
      <label className="inline-toggle">
        <input type="checkbox" checked={initializeGit} onChange={(event) => setInitializeGit(event.target.checked)} />
        初始化 Git
      </label>
      <button type="button" disabled={busy || !targetPath.trim()} onClick={() => void handleInitialize()}>
        初始化
      </button>
    </div>
  );
}
