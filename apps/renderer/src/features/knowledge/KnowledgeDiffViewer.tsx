import { useMemo, useState } from "react";

type Props = {
  diff: string;
  maxHeight?: number;
};

type DiffKind = "file" | "hunk" | "add" | "del" | "ctx" | "meta";

function classifySingle(line: string): { kind: DiffKind; text: string } {
  if (line.startsWith("@@")) return { kind: "hunk", text: line };
  if (line.startsWith("+")) return { kind: "add", text: line };
  if (line.startsWith("-")) return { kind: "del", text: line };
  if (line.includes("（无内容差异）")) return { kind: "meta", text: line };
  return { kind: "ctx", text: line };
}

export function KnowledgeDiffViewer({ diff, maxHeight = 420 }: Props) {
  const [copied, setCopied] = useState(false);

  const rows = useMemo(() => {
    const lines = diff.split("\n");
    const result: Array<{ kind: DiffKind; text: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const next = lines[index + 1] ?? "";
      if (line.startsWith("--- a/") && next.startsWith("+++ b/")) {
        result.push({ kind: "file", text: next.slice(6) });
        index += 1;
        continue;
      }
      result.push(classifySingle(line));
    }
    return result;
  }, [diff]);

  const fileCount = useMemo(() => rows.filter((row) => row.kind === "file").length, [rows]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  return (
    <div className="knowledge-diff-viewer" style={{ maxHeight }}>
      <div className="knowledge-diff-viewer__bar">
        <span className="knowledge-meta">
          {fileCount > 0 ? `${fileCount} 个文件 · ` : ""}
          {rows.length} 行
        </span>
        <button type="button" className="quiet-button" onClick={() => void copy()}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div className="knowledge-diff-viewer__body" role="log" aria-label="统一 diff">
        {rows.length === 0 || (rows.length === 1 && rows[0].text === "") ? (
          <div className="knowledge-diff-line knowledge-diff-line--meta">（无差异）</div>
        ) : (
          rows.map((row, index) => (
            <div
              key={index}
              className={`knowledge-diff-line knowledge-diff-line--${row.kind}`}
            >
              {row.text || "\u00A0"}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
