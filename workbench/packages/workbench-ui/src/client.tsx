// workbench-ui — browser half of the workbench client plugin (TSX source).
// Bundled by scripts/build-client.mjs into the DSH ModuleLoader format.
//
// Surfaces:
//   1. Keyed tool.call.toolview cards: per-tool status cards, the approval
//      inbox card, the engine-driven run map, and the visual editor card.
//   2. A conversationEvents definition ("workbench-run") feeding a turn-tail
//      activity strip and a keyed conversation.chat.node card.
//   3. A sidebar.footer.action entry ("⚙ 工作台") with a live inbox panel and
//      a full-screen react-flow visual workflow editor.
//
// react / react/jsx-runtime are provided by the DSH shell module table
// (external); @xyflow/react is bundled inline.

import * as React from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type NodeChange,
} from "@xyflow/react";
import reactFlowCss from "@xyflow/react/dist/style.css";
// Shared shell primitives (chat-grade markdown / json / diff rendering).
// Resolved at runtime through the DSH module table (same mechanism as react);
// marked external in scripts/build-client.mjs.
import { MarkdownText, JsonBlock, DiffBlock } from "@deepseek-ai/dsh-client-ui-primitives";

// --- inline the react-flow stylesheet + cursor overrides ---
const CSS_TAG_ID = "@workflow-platform/workbench-ui/xyflow.css";
if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) === null) {
  const tag = document.createElement("style");
  tag.dataset.pluginCss = CSS_TAG_ID;
  tag.textContent =
    reactFlowCss +
    // Let react-flow own the cursors: grab on nodes/pane, grabbing while
    // dragging. No inline cursor on our node box, so these class rules win.
    ".react-flow__node-draggable{cursor:grab}.react-flow__node.dragging{cursor:grabbing!important}" +
    ".react-flow__pane{cursor:grab}.react-flow__pane.dragging{cursor:grabbing!important}";
  document.head.appendChild(tag);
}

const GOVERNANCE_TOOLS = [
  "workflow_start",
  "workflow_advance",
  "workflow_audit",
  "workflow_check",
  "workflow_run_list",
  "workflow_evidence_export",
  "workflow_approval_inbox",
  "workflow_template_save",
  "workflow_template_list",
  "workflow_template_export",
  "workflow_template_import",
  "workflow_template_sync_project",
  "workflow_role_save",
  "workflow_role_list",
  "workflow_role_export",
  "workflow_role_import",
  "workflow_role_sync_project",
  "workflow_editor",
];

function statusText(status: unknown): string | null {
  if (typeof status !== "string") return null;
  const map: Record<string, string> = {
    STARTED: "已启动",
    ADVANCED: "已推进",
    COMPLETED: "已完成",
    AWAITING_APPROVAL: "等待审批",
    AWAITING_ARTIFACT: "等待产物",
    REJECTED: "已拒绝",
    NOT_CURRENT: "非当前节点",
    SAVED: "已保存",
    IMPORTED: "已导入",
    SYNCED: "已同步",
    EXPORTED: "已导出",
  };
  return map[status] ?? status;
}

function resultFacts(result: unknown): { status: string | null; runId: string | null; nodeId: string | null } {
  if (result === null || result === undefined || typeof result !== "object") {
    return { status: null, runId: null, nodeId: null };
  }
  const r = result as { status?: unknown; runId?: unknown; nodeId?: unknown };
  return {
    status: typeof r.status === "string" ? r.status : null,
    runId: typeof r.runId === "string" ? r.runId : null,
    nodeId: typeof r.nodeId === "string" ? r.nodeId : null,
  };
}

function blockResult(block: unknown): Record<string, unknown> | null {
  if (block === null || block === undefined || typeof block !== "object") return null;
  const b = block as { kind?: unknown; isError?: unknown; content?: unknown };
  if (!("kind" in b)) return null;
  if (b.isError === true) return null;
  const parts: string[] = [];
  if (Array.isArray(b.content)) {
    for (const part of b.content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") parts.push(p.text);
      else parts.push(JSON.stringify(part));
    }
  }
  if (parts.length === 0) return null;
  try {
    const parsed = JSON.parse(parts.join("\n"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function blockToolName(props: Record<string, unknown>, block: unknown): string | null {
  if (typeof props.toolName === "string" && props.toolName !== "") return props.toolName;
  const b = block as { name?: unknown; call?: { name?: unknown } } | null;
  if (b && typeof b === "object") {
    if (typeof b.name === "string") return b.name;
    if (b.call && typeof b.call.name === "string") return b.call.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Tool cards
// ---------------------------------------------------------------------------

function WorkbenchToolCard(props: { block?: unknown; toolName?: unknown }) {
  const block = props.block;
  const toolName = blockToolName(props as Record<string, unknown>, block);
  const result = blockResult(block);
  const facts = resultFacts(result);
  const running = block !== null && block !== undefined && !("kind" in (block as { kind?: unknown }));
  if (!running && facts.status === null && facts.runId === null) return null;
  const row: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", lineHeight: "20px",
    padding: "4px 8px", borderRadius: "6px",
    background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.08))", fontFamily: "inherit",
  };
  const chip: React.CSSProperties = {
    padding: "0 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600,
    color: running ? "#6b7280" : facts.status === "AWAITING_APPROVAL" || facts.status === "AWAITING_ARTIFACT" ? "#b45309" : "#166534",
    background: running ? "rgba(107,114,128,0.15)" : facts.status === "AWAITING_APPROVAL" || facts.status === "AWAITING_ARTIFACT" ? "rgba(217,119,6,0.15)" : "rgba(22,163,74,0.15)",
  };
  const code: React.CSSProperties = { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #666)" };
  return (
    <div style={row}>
      <span>工作台{toolName !== null ? " · " + toolName : ""}</span>
      {running ? <span style={chip}>执行中</span> : facts.status !== null ? <span style={chip}>{statusText(facts.status)}</span> : null}
      {facts.runId !== null ? <code style={code}>{facts.runId}</code> : null}
      {facts.nodeId !== null ? <code style={code}>node: {facts.nodeId}</code> : null}
    </div>
  );
}

function blockedByLabel(blockedBy: unknown): string {
  return blockedBy === "artifact" ? "等待产物" : "等待审批";
}

function templateActionLabel(action: string): string {
  if (action.indexOf("save") !== -1) return "模板保存待审";
  if (action.indexOf("import") !== -1) return "模板导入待审";
  if (action.indexOf("sync") !== -1) return "模板同步待审";
  return "模板变更待审";
}

function WorkbenchInboxCard(props: { block?: unknown }) {
  const result = blockResult(props.block);
  if (result === null) return null;
  const runs = Array.isArray(result.runs) ? (result.runs as Array<Record<string, unknown>>) : [];
  const templates = Array.isArray(result.templates) ? (result.templates as Array<Record<string, unknown>>) : [];
  if (runs.length === 0 && templates.length === 0) return null;
  const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "4px", padding: "4px 0", fontFamily: "inherit" };
  const header: React.CSSProperties = { fontSize: "12px", fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #444)" };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", borderRadius: "8px", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.06))" };
  const chip: React.CSSProperties = { flex: "none", padding: "1px 8px", borderRadius: "999px", fontSize: "11px", fontWeight: 600, color: "#b45309", background: "rgba(217,119,6,0.15)" };
  const main: React.CSSProperties = { flex: "1", minWidth: "0", fontSize: "13px", lineHeight: "20px" };
  const sub: React.CSSProperties = { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, #999)" };
  return (
    <div style={wrap}>
      <div style={header}>审批收件箱 · {runs.length + templates.length} 项待审（Run {runs.length}，模板 {templates.length}）</div>
      {runs.map((run, i) => (
        <div key={"run" + i} style={row}>
          <span style={chip}>{blockedByLabel(run.blockedBy)}</span>
          <div style={main}>
            <div>{String(run.workflow)} · {String(run.nodeId)}</div>
            <div style={sub}>{String(run.runId)} · {typeof run.since === "string" ? run.since.replace("T", " ").slice(0, 19) + "Z" : ""}</div>
          </div>
        </div>
      ))}
      {templates.map((tpl, i) => (
        <div key={"tpl" + i} style={row}>
          <span style={chip}>{templateActionLabel(String(tpl.action))}</span>
          <div style={main}>
            <div>{String(tpl.subject)}</div>
            <div style={sub}>{String(tpl.action)} · {typeof tpl.since === "string" ? tpl.since.replace("T", " ").slice(0, 19) + "Z" : ""}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Engine-driven run map card (workflow_start / workflow_advance)
function WorkbenchRunMapCard(props: { block?: unknown }) {
  const result = blockResult(props.block);
  const map = result !== null && typeof result.map === "object" && result.map !== null ? (result.map as Record<string, unknown>) : null;
  if (map === null) return null;
  const nodes = Array.isArray(map.nodes) ? (map.nodes as Array<Record<string, unknown>>) : [];
  const workflow = typeof map.workflow === "string" ? map.workflow : "workflow";
  const current = typeof map.current === "string" ? map.current : null;
  const blockedBy = typeof map.blockedBy === "string" ? map.blockedBy : null;
  const done = map.status === "COMPLETED" || result.status === "COMPLETED" || result.status === "ALREADY_COMPLETED";
  if (nodes.length === 0) return null;
  const currentIdx = current === null ? -1 : nodes.findIndex((n) => n && n.id === current);
  const wrap: React.CSSProperties = { border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.2))", borderRadius: "10px", padding: "8px 10px", fontFamily: "inherit", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.05))" };
  const header: React.CSSProperties = { fontSize: "12px", fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" };
  const flow: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" };
  const box = (s: { border: string; bg: string; color: string; current: boolean }): React.CSSProperties => ({ padding: "3px 8px", borderRadius: "6px", fontSize: "12px", lineHeight: "18px", border: "1px solid " + s.border, background: s.bg, color: s.color, fontWeight: s.current ? 600 : 400 });
  const arrow: React.CSSProperties = { color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "12px" };
  const styleOf = (index: number) => {
    if (done) return { border: "rgba(22,163,74,0.5)", bg: "rgba(22,163,74,0.12)", color: "#166534", current: false };
    if (index < currentIdx) return { border: "rgba(22,163,74,0.5)", bg: "rgba(22,163,74,0.12)", color: "#166534", current: false };
    if (index === currentIdx && blockedBy !== null) return { border: "rgba(217,119,6,0.6)", bg: "rgba(217,119,6,0.15)", color: "#b45309", current: true };
    if (index === currentIdx) return { border: "rgba(37,99,235,0.6)", bg: "rgba(37,99,235,0.12)", color: "#2563eb", current: true };
    return { border: "rgba(127,127,127,0.3)", bg: "transparent", color: "var(--dsw-alias-label-tertiary, #999)", current: false };
  };
  const labelOf = (index: number) => {
    if (done) return "";
    if (index < currentIdx) return "✓";
    if (index === currentIdx && blockedBy !== null) return blockedBy === "approval" ? "⏸ 待审批" : blockedBy === "artifact" ? "⏳ 待产物" : "✗ 已拒绝";
    if (index === currentIdx) return "▶";
    return "";
  };
  const blockText = blockedBy !== null ? (blockedBy === "approval" ? "等待审批" : blockedBy === "artifact" ? "等待产物" : "已拒绝") : done ? "已完成" : null;
  return (
    <div style={wrap} data-workbench-run>
      <div style={header}>工作流 · {workflow}{blockText !== null ? "（" + blockText + "）" : ""}</div>
      <div style={flow}>
        {nodes.map((node, index) => {
          if (!node || typeof node.id !== "string") return null;
          const s = styleOf(index);
          const label = labelOf(index);
          return (
            <React.Fragment key={"n" + index}>
              <span style={box(s)} title={(node.requiresApproval === true ? "需人工审批 · " : "") + node.id}>
                {label !== "" ? label + " " : ""}{node.id}{node.requiresApproval === true ? " 🔒" : ""}
              </span>
              {index < nodes.length - 1 ? <span style={arrow}>→</span> : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1d. Visual editor — react-flow canvas
// ---------------------------------------------------------------------------

interface EditorArtifact { id: string; path: string; required: boolean }
interface EditorNode { id: string; requiresApproval: boolean; artifacts: EditorArtifact[]; role?: string; roleVersion?: number }

function WorkbenchNodeBox({ data }: NodeProps) {
  const d = data as { label: string; requiresApproval: boolean; artifactCount: number; selected: boolean };
  const style: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: "10px",
    fontSize: "13px",
    fontWeight: d.selected ? 600 : 400,
    border: "1px solid " + (d.selected ? "rgba(37,99,235,0.8)" : "rgba(127,127,127,0.35)"),
    background: d.selected ? "rgba(37,99,235,0.10)" : "#fff",
    color: "#222",
    fontFamily: "inherit",
    minWidth: "110px",
    textAlign: "center" as const,
  };
  return (
    <div style={style} data-workbench-node>
      {/* Custom nodes MUST render Handles for edges to attach (react-flow #008). */}
      <Handle type="target" position={Position.Left} />
      <div>{d.label}{d.requiresApproval ? " 🔒" : ""}</div>
      {d.artifactCount > 0 ? <div style={{ fontSize: "10px", color: "#999" }}>{d.artifactCount} 个产物</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { workbenchNode: WorkbenchNodeBox };

function WorkbenchEditorCore({ initialTemplate }: { initialTemplate: Record<string, unknown> | null }) {
  const initialNodes: EditorNode[] =
    initialTemplate !== null && Array.isArray(initialTemplate.nodes) && initialTemplate.nodes.length > 0
      ? (initialTemplate.nodes as Array<Record<string, unknown>>).map((n) => ({
          id: String(n.id),
          requiresApproval: n.requiresApproval === true,
          role: typeof n.role === "string" && n.role.length > 0 ? n.role : undefined,
          roleVersion: typeof n.roleVersion === "number" ? n.roleVersion : undefined,
          artifacts: Array.isArray(n.artifacts)
            ? (n.artifacts as Array<Record<string, unknown>>).map((a) => ({ id: String(a.id), path: String(a.path), required: a.required === true }))
            : [],
        }))
      : [{ id: "start", requiresApproval: true, artifacts: [] }];
  const [name, setName] = React.useState<string>(initialTemplate !== null && typeof initialTemplate.name === "string" ? initialTemplate.name : "");
  const [nodes, setNodes] = React.useState<EditorNode[]>(initialNodes);
  const [selected, setSelected] = React.useState(0);
  const [status, setStatus] = React.useState<string | null>(null);
  // Visual drag positions (cosmetic only — the saved chain ORDER follows the
  // nodes array, controlled by the order strip buttons).
  const [positions, setPositions] = React.useState<Record<string, { x: number; y: number }>>({});
  // Role library for the node "bind role" dropdown.
  const [roles, setRoles] = React.useState<Array<Record<string, unknown>> | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch("/workbench/roles", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && data !== null && Array.isArray(data.roles)) setRoles(data.roles as Array<Record<string, unknown>>);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onNodesChange = React.useCallback((changes: NodeChange[]) => {
    setPositions((prev) => {
      const next = { ...prev };
      for (const change of changes) {
        if (change.type === "position" && change.position && change.dragging !== false) {
          next[change.id] = change.position;
        }
      }
      return next;
    });
  }, []);

  const rfNodes: Node[] = nodes.map((n, i) => {
    const pos = positions["wbn-" + i] ?? { x: 40 + i * 230, y: 50 };
    return {
      id: "wbn-" + i,
      position: pos,
      // Pre-seed measured dims so calculateNodePosition never warns #015
      // ("node was not measured") before the ResizeObserver lands.
      measured: { width: 150, height: 58 },
      data: { label: n.id, requiresApproval: n.requiresApproval, artifactCount: n.artifacts.length, selected: i === selected },
      type: "workbenchNode",
    };
  });
  const rfEdges: Edge[] = nodes.slice(1).map((_, i) => ({ id: "wbe-" + i, source: "wbn-" + i, target: "wbn-" + (i + 1), animated: true }));

  const move = (dir: number) => {
    const i = selected;
    const j = i + dir;
    if (j < 0 || j >= nodes.length) return;
    const next = [...nodes];
    [next[i], next[j]] = [next[j], next[i]];
    setNodes(next);
    setSelected(j);
  };
  const remove = () => {
    if (nodes.length <= 1) return;
    setNodes(nodes.filter((_, i) => i !== selected));
    setSelected(Math.max(0, selected - 1));
  };
  const patchNode = (patch: Partial<EditorNode>) => setNodes(nodes.map((n, i) => (i === selected ? { ...n, ...patch } : n)));
  const patchArtifact = (ai: number, patch: Partial<EditorArtifact>) =>
    patchNode({ artifacts: nodes[selected].artifacts.map((a, x) => (x === ai ? { ...a, ...patch } : a)) });
  const save = () => {
    setStatus("saving…");
    fetch("/workbench/template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, firstNode: nodes.length > 0 ? nodes[0].id : "", nodes }),
    })
      .then((r) => r.json())
      .then((d) => setStatus(d && d.status === "SAVED" ? "✓ 已保存 v" + d.version + "（ui-editor）" : "✗ " + (d && d.error ? d.error : JSON.stringify(d))))
      .catch((e) => setStatus("✗ " + e.message));
  };

  const btn: React.CSSProperties = { fontSize: "11px", padding: "2px 8px", borderRadius: "999px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", background: "transparent", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #444)", fontFamily: "inherit" };
  const input: React.CSSProperties = { fontSize: "12px", padding: "2px 6px", borderRadius: "4px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))", background: "var(--dsw-alias-bg-module-strong, #fff)", color: "var(--dsw-alias-label-primary, #222)", fontFamily: "inherit" };
  const node = nodes[selected];

  return (
    <div style={{ fontFamily: "inherit" }} data-workbench-editor>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)" }}>
        工作流可视化编辑器
        <span style={{ fontSize: "11px", fontWeight: 400, color: "#999" }}>react-flow 画布 · 拖拽调整 · 顺序由左侧列表决定</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px", fontSize: "12px" }}>
        <span>名称</span>
        <input style={{ ...input, width: 160 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="workflow-name" />
        <span style={{ marginLeft: "8px" }}>节点顺序</span>
        {nodes.map((n, i) => (
          <React.Fragment key={"o" + i}>
            <button
              style={{ ...btn, borderColor: i === selected ? "rgba(37,99,235,0.8)" : "rgba(127,127,127,0.35)", color: i === selected ? "#2563eb" : "#444", fontWeight: i === selected ? 600 : 400 }}
              onClick={() => setSelected(i)}
            >
              {n.id}{n.requiresApproval ? " 🔒" : ""}
            </button>
            {i < nodes.length - 1 ? <span style={{ color: "#999", fontSize: "11px" }}>→</span> : null}
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px", flexWrap: "wrap" }}>
        <button style={btn} onClick={() => { setNodes([...nodes, { id: "node" + (nodes.length + 1), requiresApproval: true, artifacts: [] }]); setSelected(nodes.length); }}>+ 添加节点</button>
        <button style={btn} onClick={() => move(-1)}>↑ 前移</button>
        <button style={btn} onClick={() => move(1)}>↓ 后移</button>
        <button style={btn} onClick={remove}>删除选中</button>
        <button style={{ ...btn, marginLeft: "auto", borderColor: "rgba(37,99,235,0.6)", color: "#2563eb" }} onClick={save}>保存模板</button>
      </div>
      <div style={{ height: 340, border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.2))", borderRadius: "10px", overflow: "hidden", marginBottom: "10px" }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.3}
          panOnDrag={[1, 2]}
          panActivationKeyCode="Space"
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setSelected(Number(node.id.replace("wbn-", "")))}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <div style={{ fontSize: "11px", color: "#999", marginBottom: "8px" }}>提示：左键拖节点（唯一左键拖拽目标）；中键/右键拖背景平移画布（或按住空格+左键）；滚轮缩放。保存顺序由上方节点顺序条 ↑↓ 决定。</div>
      {node ? (
        <div style={{ padding: "10px", borderRadius: "10px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.15))", marginBottom: "8px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, marginBottom: "6px", color: "var(--dsw-alias-label-secondary, #444)" }}>节点 #{selected + 1} 配置</div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px", fontSize: "12px" }}>
            <span>id</span>
            <input style={{ ...input, width: 120 }} value={node.id} onChange={(e) => patchNode({ id: e.target.value })} />
            <label style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <input type="checkbox" checked={node.requiresApproval} onChange={(e) => patchNode({ requiresApproval: e.target.checked })} />
              需人工审批
            </label>
            <span style={{ marginLeft: "6px" }}>角色</span>
            <select
              style={{ ...input, width: 170 }}
              value={node.role ?? ""}
              onChange={(e) => {
                const roleName = e.target.value;
                const next: EditorNode = { ...node, role: roleName === "" ? undefined : roleName, roleVersion: roleName === "" ? undefined : node.roleVersion };
                if (roleName !== "" && roles !== null) {
                  const role = roles.find((r) => String(r.name) === roleName);
                  if (role !== undefined && Array.isArray(role.outputs)) {
                    // Bind role: freeze the CURRENT role version and auto-fill
                    // artifacts from its outputs (a fixed snapshot).
                    next.roleVersion = typeof role.version === "number" ? role.version : undefined;
                    next.artifacts = (role.outputs as Array<Record<string, unknown>>).map((a) => ({
                      id: String(a.id),
                      path: String(a.path),
                      required: a.required === true,
                    }));
                  }
                }
                setNodes(nodes.map((n, i) => (i === selected ? next : n)));
              }}
            >
              <option value="">（不绑定）</option>
              {roles === null
                ? null
                : roles.map((r, ri) => (
                    <option key={"ro" + ri} value={String(r.name)}>
                      {String(r.name)} v{String(r.version)}
                    </option>
                  ))}
            </select>
            {node.role !== undefined ? (
              <span style={{ fontSize: "10px", color: "#6d28d9" }}>
                {node.role}@{node.roleVersion ?? "?"} · 固定快照
              </span>
            ) : null}
          </div>
          {node.role !== undefined ? (
            <div style={{ fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", marginBottom: "4px" }}>
              产物来自角色契约（只读快照，随模板保存固化）。角色改版后点"↻ 同步契约"拉取最新。
            </div>
          ) : null}
          {node.artifacts.map((a, ai) => (
            <div key={"a" + ai} style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", fontSize: "12px" }}>
              <input style={{ ...input, width: 70, ...(node.role !== undefined ? { background: "rgba(127,127,127,0.06)", color: "#666" } : {}) }} value={a.id} disabled={node.role !== undefined} onChange={(e) => patchArtifact(ai, { id: e.target.value })} />
              <input style={{ ...input, flex: 1, ...(node.role !== undefined ? { background: "rgba(127,127,127,0.06)", color: "#666" } : {}) }} value={a.path} disabled={node.role !== undefined} onChange={(e) => patchArtifact(ai, { path: e.target.value })} />
              <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }}>
                <input type="checkbox" checked={a.required} disabled={node.role !== undefined} onChange={(e) => patchArtifact(ai, { required: e.target.checked })} />
                必需
              </label>
              <button style={btn} disabled={node.role !== undefined} onClick={() => patchNode({ artifacts: node.artifacts.filter((_, x) => x !== ai) })}>删</button>
            </div>
          ))}
          {node.role !== undefined ? (
            <button
              style={{ ...btn, color: "#2563eb", borderColor: "rgba(37,99,235,0.6)" }}
              onClick={() => {
                const role = roles !== null ? roles.find((r) => String(r.name) === node.role) : undefined;
                if (role !== undefined && Array.isArray(role.outputs)) {
                  const next: EditorNode = {
                    ...node,
                    roleVersion: typeof role.version === "number" ? role.version : node.roleVersion,
                    artifacts: (role.outputs as Array<Record<string, unknown>>).map((a) => ({
                      id: String(a.id),
                      path: String(a.path),
                      required: a.required === true,
                    })),
                  };
                  setNodes(nodes.map((n, i) => (i === selected ? next : n)));
                  setStatus("↻ 已同步角色 " + String(node.role) + " v" + String(next.roleVersion) + "（保存后生效）");
                }
              }}
            >
              ↻ 同步契约
            </button>
          ) : (
            <button style={btn} onClick={() => patchNode({ artifacts: [...node.artifacts, { id: "art" + (node.artifacts.length + 1), path: "artifacts/new.md", required: true }] })}>+ 产物</button>
          )}
        </div>
      ) : null}
      {status !== null ? <div style={{ fontSize: "12px", color: String(status).indexOf("✓") === 0 ? "#166534" : "#b45309" }}>{String(status)}</div> : null}
    </div>
  );
}

function WorkbenchEditorCard(props: { block?: unknown }) {
  const result = blockResult(props.block);
  const initial = result !== null && typeof result.template === "object" && result.template !== null ? (result.template as Record<string, unknown>) : null;
  return <WorkbenchEditorCore initialTemplate={initial} />;
}

// ---------------------------------------------------------------------------
// 2. Conversation definition + turn-tail / run-node surfaces
// ---------------------------------------------------------------------------

interface ActivityItem { seq: number; tool: string; status: string | null; runId: string | null; nodeId: string | null; current: string | null }

const workbenchRunDefinition = {
  kind: "workbench-run",
  target: "chat",
  match: (event: { type: string; data: { turn?: unknown } }) => {
    if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
    if (event.type === "tool/call") return { id: String(event.data.turn), role: "update" };
    if (event.type === "tool/result") return { id: String(event.data.turn), role: "update" };
    return null;
  },
  start: (_context: unknown, match: { event: { type: string; data: { turn?: unknown } } }) => {
    if (match.event.type !== "turn/start") throw new Error("workbench-run start requires turn/start");
    return { turn: match.event.data.turn, calls: new Map(), activity: [] as ActivityItem[], nodes: null, workflow: null };
  },
  update: (context: { state: { calls: Map<string, string | null>; activity: ActivityItem[]; nodes: unknown; workflow: string | null } }, match: unknown) => {
    const m = match as { event: { type: string; data: { callId?: unknown; name?: unknown; message?: { source?: { callId?: unknown }; content?: Array<{ content?: Array<{ type?: string; text?: string; isError?: boolean }> }> }; error?: unknown } } };
    if (m.event.type === "tool/call") {
      const calls = new Map(context.state.calls);
      const name = typeof m.event.data.name === "string" ? m.event.data.name : null;
      calls.set(String(m.event.data.callId), name);
      return { ...context.state, calls };
    }
    if (m.event.type !== "tool/result") return context.state;
    const message = m.event.data.message;
    const outer = message && Array.isArray(message.content) ? message.content : [];
    const first = outer[0];
    const inner = first && Array.isArray(first.content) ? first.content : [];
    const texts = inner.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
    const isError = m.event.data.error !== undefined || (inner[0] && inner[0].isError === true);
    const callId = message && message.source ? String(message.source.callId) : null;
    const tool = callId !== null ? context.state.calls.get(callId) ?? null : null;
    if (tool === null || !GOVERNANCE_TOOLS.includes(tool)) return context.state;
    let result: Record<string, unknown> | null = null;
    if (!isError && texts.length > 0) {
      try {
        const parsed = JSON.parse(texts.join("\n"));
        if (parsed !== null && typeof parsed === "object") result = parsed as Record<string, unknown>;
      } catch {
        result = null;
      }
    }
    const facts = resultFacts(result);
    const entry: ActivityItem = {
      seq: m.event ? (match as { event: { seq: number } }).event.seq : 0,
      tool,
      ...facts,
      current: result !== null && typeof result.current === "string" ? result.current : null,
    };
    const next = { ...context.state, activity: [...context.state.activity, entry] };
    if (tool === "workflow_start" && result !== null && Array.isArray(result.nodes)) {
      next.nodes = result.nodes;
      next.workflow = typeof result.workflow === "string" ? result.workflow : next.workflow;
    }
    return next;
  },
  buildLocationData: (context: { state: { activity: ActivityItem[]; nodes: unknown; workflow: string | null }; turn?: unknown }, scope: string) =>
    scope !== "turn" || context.state === undefined
      ? null
      : { kind: "turn", turn: context.state.turn, key: "workbench-run", value: { activity: context.state.activity, nodes: context.state.nodes, workflow: context.state.workflow } },
  buildViewNode: (context: unknown) => {
    const c = context as { start?: unknown; state?: { activity: ActivityItem[]; nodes: unknown; workflow: string | null }; key: string; id: string };
    if (c.start === undefined || c.state === undefined) return null;
    return {
      key: c.key,
      kind: "workbench-run",
      id: c.id,
      target: "chat",
      anchorSeq: (c.start as { event: { seq: number } }).event.seq,
      location: (c.start as { location: unknown }).location,
      visibility: "visible",
      data: { activity: c.state.activity, nodes: c.state.nodes, workflow: c.state.workflow },
    };
  },
};

function selectWorkbenchActivity(owner: { turn?: { data?: Map<string, { activity?: unknown }> } }): ActivityItem[] | null {
  const data = owner && owner.turn && owner.turn.data ? owner.turn.data.get("workbench-run") : null;
  const activity = data && Array.isArray(data.activity) ? (data.activity as ActivityItem[]) : [];
  return activity.length === 0 ? null : activity;
}

function activityRow(activity: ActivityItem[]) {
  return activity.map((item) => {
    const status = statusText(item.status);
    const chip: React.CSSProperties = {
      padding: "0 6px", borderRadius: "999px", fontSize: "11px", fontWeight: 600,
      color: item.status === "AWAITING_APPROVAL" || item.status === "AWAITING_ARTIFACT" ? "#b45309" : "#166534",
      background: item.status === "AWAITING_APPROVAL" || item.status === "AWAITING_ARTIFACT" ? "rgba(217,119,6,0.15)" : "rgba(22,163,74,0.15)",
    };
    return (
      <span key={item.seq} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", lineHeight: "18px" }}>
        <span>{item.tool}</span>
        {status !== null ? <span style={chip}>{status}</span> : null}
        {item.runId !== null && item.runId !== undefined ? <code style={{ fontSize: "11px", color: "var(--dsw-alias-label-secondary, #666)" }}>{item.runId}</code> : null}
      </span>
    );
  });
}

function WorkbenchActivityStrip(props: { matched?: ActivityItem[] }) {
  const activity = props && Array.isArray(props.matched) ? props.matched : [];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: "4px 0", borderTop: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.15))", marginTop: "4px" }}>
      <span style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", marginRight: "4px" }}>工作台</span>
      {activityRow(activity)}
    </div>
  );
}

function WorkbenchRunNodeCard(props: { node?: { data?: { activity: ActivityItem[] } } }) {
  const data = props && props.node && props.node.data ? props.node.data : null;
  const activity = data && Array.isArray(data.activity) ? data.activity : [];
  if (activity.length === 0) return null;
  return (
    <div style={{ border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.2))", borderRadius: "10px", padding: "8px 10px", fontFamily: "inherit", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.05))" }} data-workbench-run>
      <div style={{ fontSize: "12px", fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "4px" }}>工作台 · Run 活动</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>{activityRow(activity)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3b. Role library: list + form editor (contracts: description / inputs / outputs)
// ---------------------------------------------------------------------------

function RoleArtifactEditor(props: {
  title: string;
  items: Array<Record<string, unknown>>;
  onChange: (items: Array<Record<string, unknown>>) => void;
}) {
  const { title, items, onChange } = props;
  const patch = (i: number, p: Record<string, unknown>) => onChange(items.map((a, x) => (x === i ? { ...a, ...p } : a)));
  const [openTpl, setOpenTpl] = React.useState<number | null>(null);
  const btn: React.CSSProperties = { fontSize: "11px", padding: "2px 8px", borderRadius: "999px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", background: "transparent", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #444)", fontFamily: "inherit" };
  const input: React.CSSProperties = { fontSize: "12px", padding: "2px 6px", borderRadius: "4px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))", background: "var(--dsw-alias-bg-module-strong, #fff)", color: "var(--dsw-alias-label-primary, #222)", fontFamily: "inherit" };
  return (
    <div style={{ padding: "10px 14px", borderRadius: "10px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.15))" }}>
      <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" }}>
        {title}
        <span style={{ marginLeft: "6px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" }}>每行可配内容模板（可选）</span>
      </div>
      {items.length === 0 ? <div style={hintStyle}>（空）</div> : null}
      {items.map((a, i) => (
        <React.Fragment key={"ra" + i}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", fontSize: "12px" }}>
            <input style={{ ...input, width: 90 }} value={String(a.id ?? "")} onChange={(e) => patch(i, { id: e.target.value })} placeholder="id" />
            <input style={{ ...input, flex: 1 }} value={String(a.path ?? "")} onChange={(e) => patch(i, { path: e.target.value })} placeholder="artifacts/xxx.md" />
            <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }}>
              <input type="checkbox" checked={a.required === true} onChange={(e) => patch(i, { required: e.target.checked })} />
              必需
            </label>
            <button style={{ ...btn, color: openTpl === i ? "#2563eb" : "var(--dsw-alias-label-secondary, #444)", borderColor: openTpl === i ? "rgba(37,99,235,0.6)" : "var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))" }} onClick={() => setOpenTpl(openTpl === i ? null : i)}>
              模板{typeof a.template === "string" && a.template.trim().length > 0 ? " ✓" : ""}
            </button>
            <button style={btn} onClick={() => onChange(items.filter((_, x) => x !== i))}>删</button>
          </div>
          {openTpl === i ? (
            <div style={{ marginBottom: "6px" }}>
              <textarea
                style={{ width: "100%", fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))", background: "var(--dsw-alias-bg-module-strong, #fff)", color: "var(--dsw-alias-label-primary, #222)", fontFamily: "monospace", minHeight: 64, resize: "vertical", boxSizing: "border-box" }}
                value={typeof a.template === "string" ? a.template : ""}
                onChange={(e) => patch(i, { template: e.target.value })}
                placeholder={"产物内容模板（可选）：agent 缺失产物时按此生成。例：# {title}\n\n## 内容\n- "}
              />
              <div style={{ fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", marginTop: "2px" }}>留空 = 无模板；填了会在产物缺失时注入给 agent，并随证据快照。</div>
            </div>
          ) : null}
        </React.Fragment>
      ))}
      <button style={btn} onClick={() => onChange([...items, { id: "art" + (items.length + 1), path: "artifacts/new.md", required: true }])}>+ 添加</button>
    </div>
  );
}
const hintStyle: React.CSSProperties = { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" };

function WorkbenchHub({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = React.useState<"inbox" | "workflows" | "roles" | "runs" | "artifacts">("inbox");
  const [view, setView] = React.useState<"hub" | "editor" | "roleEditor">("hub");
  const [inbox, setInbox] = React.useState<{ runs: Array<Record<string, unknown>>; templates: Array<Record<string, unknown>> } | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [templateList, setTemplateList] = React.useState<{ templates: Array<Record<string, unknown>>; projectFiles: string[] } | null>(null);
  const [rolesList, setRolesList] = React.useState<{ roles: Array<Record<string, unknown>>; projectFiles: string[] } | null>(null);
  const [runsList, setRunsList] = React.useState<Array<Record<string, unknown>> | null>(null);
  const [editorTemplate, setEditorTemplate] = React.useState<Record<string, unknown> | null>(null);
  const [roleDraft, setRoleDraft] = React.useState<Record<string, unknown> | null>(null);
  // 产物模块 state
  const [artifactsList, setArtifactsList] = React.useState<Array<Record<string, unknown>> | null>(null);
  const [selectedArtifact, setSelectedArtifact] = React.useState<Record<string, unknown> | null>(null);
  const [artifactDetail, setArtifactDetail] = React.useState<Record<string, unknown> | null>(null);
  const [artifactDiff, setArtifactDiff] = React.useState<Record<string, unknown> | null>(null);
  const [artifactFilter, setArtifactFilter] = React.useState("");
  const [artifactStatus, setArtifactStatus] = React.useState<"all" | "ok" | "drifted" | "missing">("all");
  // 运行详情抽屉（runs tab 点击行打开）
  const [runDetail, setRunDetail] = React.useState<Record<string, unknown> | null>(null);

  // Live inbox (5s poll, while the hub is mounted).
  React.useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/workbench/inbox", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!alive || data === null) return;
          setInbox(data as { runs: Array<Record<string, unknown>>; templates: Array<Record<string, unknown>> });
          setUpdatedAt(new Date());
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Templates + runs: fetch on tab switch.
  React.useEffect(() => {
    if (tab !== "workflows") return;
    let alive = true;
    fetch("/workbench/templates", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && data !== null) setTemplateList(data as { templates: Array<Record<string, unknown>>; projectFiles: string[] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab]);

  React.useEffect(() => {
    if (tab !== "runs") return;
    let alive = true;
    fetch("/workbench/runs", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && Array.isArray(data)) setRunsList(data as Array<Record<string, unknown>>);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab]);

  // Roles: fetch on tab switch.
  React.useEffect(() => {
    if (tab !== "roles") return;
    let alive = true;
    fetch("/workbench/roles", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && data !== null) setRolesList(data as { roles: Array<Record<string, unknown>>; projectFiles: string[] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab, rolesList === null]);

  // 产物: fetch on tab switch.
  React.useEffect(() => {
    if (tab !== "artifacts") return;
    let alive = true;
    fetch("/workbench/artifacts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!alive || data === null) return;
        const list = data && Array.isArray((data as { artifacts?: unknown }).artifacts)
          ? ((data as { artifacts: Array<Record<string, unknown>> }).artifacts)
          : [];
        setArtifactsList(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab]);

  const openArtifact = (row: Record<string, unknown>, version?: number) => {
    setSelectedArtifact(row);
    setArtifactDiff(null);
    setArtifactDetail(null);
    const params: Record<string, string> = {
      runId: String(row.runId ?? ""),
      nodeId: String(row.nodeId ?? ""),
      artifactId: String(row.artifactId ?? ""),
    };
    if (version !== undefined) params.version = String(version);
    const q = new URLSearchParams(params).toString();
    fetch("/workbench/artifact?" + q, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data !== null) setArtifactDetail(data as Record<string, unknown>); })
      .catch(() => {});
  };

  const openArtifactDiff = (version: number, against: number) => {
    if (selectedArtifact === null) return;
    setArtifactDiff(null);
    const q = new URLSearchParams({
      runId: String(selectedArtifact.runId ?? ""),
      nodeId: String(selectedArtifact.nodeId ?? ""),
      artifactId: String(selectedArtifact.artifactId ?? ""),
      version: String(version),
      against: String(against),
    }).toString();
    fetch("/workbench/artifact?" + q, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data !== null) setArtifactDiff(data as Record<string, unknown>); })
      .catch(() => {});
  };

  const fetchRunDetail = (runId: string, cb?: (detail: Record<string, unknown>) => void) => {
    fetch("/workbench/run-detail?runId=" + encodeURIComponent(runId), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data === null) return;
        setRunDetail(data as Record<string, unknown>);
        if (cb) cb(data as Record<string, unknown>);
      })
      .catch(() => {});
  };

  const goToArtifactFromRun = (detail: Record<string, unknown>, artifact: Record<string, unknown>) => {
    setTab("artifacts");
    setRunDetail(detail);
    openArtifact(artifact);
  };

  const openEditor = (name: string) => {
    fetch("/workbench/template?name=" + encodeURIComponent(name), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setEditorTemplate(data && data.template ? data.template : null);
        setView("editor");
      })
      .catch(() => {
        setEditorTemplate(null);
        setView("editor");
      });
  };
  const openNewEditor = () => {
    setEditorTemplate(null);
    setView("editor");
  };
  const openRoleEditor = (role: Record<string, unknown> | null) => {
    setRoleDraft(
      role !== null
        ? role
        : { name: "", version: 1, description: "", inputs: [], outputs: [{ id: "out", path: "artifacts/out.md", required: true, template: "" }] },
    );
    setView("roleEditor");
  };
  const saveRoleDraft = () => {
    if (roleDraft === null) return;
    fetch("/workbench/roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: roleDraft.name, description: roleDraft.description, inputs: roleDraft.inputs, outputs: roleDraft.outputs }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.status === "SAVED") {
          setView("hub");
          setRolesList(null); // force refetch
        } else {
          window.alert("角色保存失败: " + (d && d.error ? d.error : JSON.stringify(d)));
        }
      })
      .catch((e) => window.alert("角色保存失败: " + e.message));
  };

  // --- export / import helpers (templates + roles) ----------------------
  const downloadJson = (fileName: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  // Export one template as a portable document (schema-tagged).
  const exportTemplateFile = (tpl: Record<string, unknown>) => {
    downloadJson("template-" + String(tpl.name) + ".json", {
      schema: "workbench-template/v1",
      name: tpl.name,
      version: tpl.version,
      firstNode: tpl.firstNode,
      nodes: tpl.nodes,
    });
  };
  // Export one role as a portable document (schema-tagged).
  const exportRoleFile = (role: Record<string, unknown>) => {
    downloadJson("role-" + String(role.name) + ".json", {
      schema: "workbench-role/v1",
      name: role.name,
      role: { description: role.description, inputs: role.inputs, outputs: role.outputs },
    });
  };
  // Import a template JSON file (ui-editor audit path via POST /workbench/template).
  const importTemplateFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(String(reader.result)) as { schema?: unknown; name?: unknown; firstNode?: unknown; nodes?: unknown };
        if (typeof doc.name !== "string" || typeof doc.firstNode !== "string" || !Array.isArray(doc.nodes)) {
          window.alert("导入失败：文件需要 {name, firstNode, nodes} 字段");
          return;
        }
        fetch("/workbench/template", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: doc.name, firstNode: doc.firstNode, nodes: doc.nodes }),
        })
          .then((r) => r.json())
          .then((d) => {
            window.alert(d && d.status === "SAVED" ? "模板已导入（v" + String(d.version) + "，ui-editor 审计）" : "导入失败: " + (d && d.error ? d.error : JSON.stringify(d)));
            setTemplateList(null); // force refetch
          })
          .catch((e) => window.alert("导入失败: " + e.message));
      } catch (e) {
        window.alert("导入失败：JSON 解析错误 " + (e instanceof Error ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  };
  // Import a role JSON file (ui-editor audit path via POST /workbench/roles).
  const importRoleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(String(reader.result)) as { schema?: unknown; name?: unknown; role?: { description?: unknown; inputs?: unknown; outputs?: unknown } };
        const roleName = typeof doc.name === "string" && doc.name.length > 0 ? doc.name : (doc.role && typeof (doc.role as { name?: unknown }).name === "string" ? String((doc.role as { name?: unknown }).name) : "");
        const roleObj = doc.role;
        if (roleName === "" || roleObj === undefined || typeof roleObj.description !== "string" || !Array.isArray(roleObj.inputs) || !Array.isArray(roleObj.outputs)) {
          window.alert("导入失败：文件需要 {name, role:{description, inputs, outputs}} 字段");
          return;
        }
        fetch("/workbench/roles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: roleName, description: roleObj.description, inputs: roleObj.inputs, outputs: roleObj.outputs }),
        })
          .then((r) => r.json())
          .then((d) => {
            window.alert(d && d.status === "SAVED" ? "角色已导入（v" + String(d.version) + "，ui-editor 审计）" : "导入失败: " + (d && d.error ? d.error : JSON.stringify(d)));
            setRolesList(null); // force refetch
          })
          .catch((e) => window.alert("导入失败: " + e.message));
      } catch (e) {
        window.alert("导入失败：JSON 解析错误 " + (e instanceof Error ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  };
  const fileInputKey = (kind: "template" | "role") => "wb-import-" + kind;

  const runStatusChip = (status: unknown): React.CSSProperties => {
    const s = String(status);
    const pending = s === "RUNNING" || s === "AWAITING_APPROVAL" || s === "AWAITING_ARTIFACT";
    return { flex: "none", padding: "1px 10px", borderRadius: "999px", fontSize: "11px", fontWeight: 600, color: s === "COMPLETED" ? "#166534" : pending ? "#b45309" : s === "REJECTED" ? "#b91c1c" : "#6b7280", background: s === "COMPLETED" ? "rgba(22,163,74,0.14)" : pending ? "rgba(217,119,6,0.14)" : s === "REJECTED" ? "rgba(185,28,28,0.12)" : "rgba(107,114,128,0.14)" };
  };
  const fmt = (ts: unknown) => (typeof ts === "string" ? ts.replace("T", " ").slice(0, 19) : "");

  const runs = inbox && Array.isArray(inbox.runs) ? inbox.runs : [];
  const templates = inbox && Array.isArray(inbox.templates) ? inbox.templates : [];

  const tabBtn = (t: "inbox" | "workflows" | "roles" | "runs" | "artifacts", label: string): React.ReactElement => (
    <button
      type="button"
      style={{ fontSize: "13px", padding: "6px 16px", borderRadius: "999px", border: "1px solid " + (tab === t ? "rgba(37,99,235,0.8)" : "var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))"), color: tab === t ? "#2563eb" : "var(--dsw-alias-label-secondary, #444)", background: tab === t ? "rgba(37,99,235,0.08)" : "transparent", cursor: "pointer", fontFamily: "inherit", fontWeight: tab === t ? 600 : 400 }}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );

  const hubStyle: React.CSSProperties = { position: "fixed", top: "24px", left: "320px", right: "24px", bottom: "24px", zIndex: 300, background: "var(--dsw-alias-bg-module-strong, #fff)", borderRadius: "14px", boxShadow: "0 16px 64px rgba(0,0,0,0.35)", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.2))", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "inherit" };
  const hubHeader: React.CSSProperties = { display: "flex", alignItems: "center", gap: "10px", padding: "12px 18px", borderBottom: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.15))" };
  const hubTitle: React.CSSProperties = { fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary, #222)" };
  const pill = (main: string, sub: string): React.CSSProperties => ({ fontSize: "12px", padding: "6px 16px", borderRadius: "999px", border: "1px solid " + main, color: sub, background: "transparent", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 });
  const sectionTitle: React.CSSProperties = { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" };
  const hint: React.CSSProperties = { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" };
  const empty: React.CSSProperties = { padding: "48px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", borderRadius: "10px", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.06))" };
  const rowMain: React.CSSProperties = { flex: "1", minWidth: 0 };
  const rowTitle: React.CSSProperties = { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" };
  const rowSub: React.CSSProperties = { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" };
  const chip = (text: string, fg: string, bg: string): React.CSSProperties => ({ flex: "none", padding: "2px 12px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, color: fg, background: bg });
  const listWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "8px" };
  const page: React.CSSProperties = { flex: 1, overflow: "auto", padding: "16px 20px" };

  return (
    <div style={hubStyle} data-workbench-hub>
      <div style={hubHeader}>
        <span style={hubTitle}>工作台</span>
        <div style={{ display: "flex", gap: "6px", marginLeft: "6px" }}>
          {tabBtn("inbox", "审批收件箱")}
          {tabBtn("workflows", "工作流模板")}
          {tabBtn("roles", "角色库")}
          {tabBtn("runs", "运行记录")}
          {tabBtn("artifacts", "产物")}
        </div>
        <span style={{ flex: 1 }} />
        {view === "editor" || view === "roleEditor" ? (
          <button type="button" style={pill("var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", "var(--dsw-alias-label-secondary, #444)")} onClick={() => setView("hub")}>‹ 返回</button>
        ) : null}
        <button type="button" style={pill("rgba(185,28,28,0.5)", "#b91c1c")} onClick={onClose}>关闭</button>
      </div>
      {view === "editor" ? (
        <div style={page}>
          <WorkbenchEditorCore initialTemplate={editorTemplate} />
        </div>
      ) : view === "roleEditor" && roleDraft !== null ? (
        <div style={page}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
            <span style={sectionTitle}>{String(roleDraft.name || "(新建角色)")}</span>
            <span style={hint}>角色契约 · 保存计入 ui-editor 审计 · 节点绑定固定版本</span>
            <span style={{ flex: 1 }} />
            <button type="button" style={pill("rgba(37,99,235,0.6)", "#2563eb")} onClick={saveRoleDraft}>保存角色</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: 720 }}>
            <div style={row}>
              <span style={{ flex: "none", width: 90, fontWeight: 600, fontSize: "12px" }}>角色名</span>
              <input
                style={{ flex: 1, fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))", background: "var(--dsw-alias-bg-module-strong, #fff)", color: "var(--dsw-alias-label-primary, #222)", fontFamily: "inherit" }}
                value={String(roleDraft.name ?? "")}
                onChange={(e) => setRoleDraft({ ...roleDraft, name: e.target.value })}
                placeholder="如 planner / verifier"
              />
            </div>
            <div style={row}>
              <span style={{ flex: "none", width: 90, fontWeight: 600, fontSize: "12px" }}>角色内容</span>
              <textarea
                style={{ flex: 1, fontSize: "13px", padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))", background: "var(--dsw-alias-bg-module-strong, #fff)", color: "var(--dsw-alias-label-primary, #222)", fontFamily: "inherit", minHeight: 72, resize: "vertical" }}
                value={String(roleDraft.description ?? "")}
                onChange={(e) => setRoleDraft({ ...roleDraft, description: e.target.value })}
                placeholder="职责、约束、这个环节干什么"
              />
            </div>
            <RoleArtifactEditor
              title="接受的产物（上游 inputs）"
              items={Array.isArray(roleDraft.inputs) ? (roleDraft.inputs as Array<Record<string, unknown>>) : []}
              onChange={(inputs) => setRoleDraft({ ...roleDraft, inputs })}
            />
            <RoleArtifactEditor
              title="输出产物（outputs）"
              items={Array.isArray(roleDraft.outputs) ? (roleDraft.outputs as Array<Record<string, unknown>>) : []}
              onChange={(outputs) => setRoleDraft({ ...roleDraft, outputs })}
            />
          </div>
        </div>
      ) : tab === "inbox" ? (
        <div style={page}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
            <span style={sectionTitle}>审批收件箱</span>
            <span style={{ fontSize: "11px", padding: "2px 10px", borderRadius: "999px", fontWeight: 600, color: "#166534", background: "rgba(22,163,74,0.14)" }}>实时 · 每 5s 刷新{updatedAt !== null ? " · " + updatedAt.toLocaleTimeString() : ""}</span>
            <span style={hint}>{runs.length + templates.length} 项待审（Run {runs.length}，模板 {templates.length}）</span>
          </div>
          {runs.length === 0 && templates.length === 0 ? (
            <div style={empty}>当前无待审批项。对话中运行到审批节点时会出现在这里。</div>
          ) : (
            <div style={listWrap}>
              {runs.map((run, i) => (
                <div key={"run" + i} style={row}>
                  <span style={chip(blockedByLabel(run.blockedBy), "#b45309", "rgba(217,119,6,0.15)")}>{blockedByLabel(run.blockedBy)}</span>
                  <div style={rowMain}>
                    <div style={rowTitle}>{String(run.workflow)} · {String(run.nodeId)}</div>
                    <div style={rowSub}>{String(run.runId)} · {fmt(run.since)}</div>
                  </div>
                  <span style={hint}>在对话中审批（弹卡）或 headless 决策文件</span>
                </div>
              ))}
              {templates.map((tpl, i) => (
                <div key={"tpl" + i} style={row}>
                  <span style={chip(templateActionLabel(String(tpl.action)), "#b45309", "rgba(217,119,6,0.15)")}>{templateActionLabel(String(tpl.action))}</span>
                  <div style={rowMain}>
                    <div style={rowTitle}>{String(tpl.subject)}</div>
                    <div style={rowSub}>{String(tpl.action)} · {fmt(tpl.since)}</div>
                  </div>
                  <span style={hint}>模板变更需人工批准（对话/决策文件）</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : tab === "workflows" ? (
        <div style={page}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
            <span style={sectionTitle}>工作流模板</span>
            <span style={hint}>管理员定义 · 点击行进入可视化编辑器（保存计入 ui-editor 审计）</span>
            <span style={{ flex: 1 }} />
            <label style={{ ...pill("var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", "var(--dsw-alias-label-secondary, #444)"), display: "inline-block", cursor: "pointer" }}>
              导入 JSON
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                key={fileInputKey("template")}
                onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) importTemplateFile(f); e.currentTarget.value = ""; }}
              />
            </label>
            <button type="button" style={pill("rgba(37,99,235,0.6)", "#2563eb")} onClick={openNewEditor}>＋ 新建工作流</button>
          </div>
          {templateList === null ? (
            <div style={empty}>加载中…</div>
          ) : templateList.templates.length === 0 ? (
            <div style={empty}>暂无模板，点右上角"＋ 新建工作流"创建第一个。</div>
          ) : (
            <div style={listWrap}>
              {templateList.templates.map((tpl, i) => (
                <div
                  key={"wt" + i}
                  style={{ ...row, cursor: "pointer", border: "1px solid transparent" }}
                  onClick={() => openEditor(String(tpl.name))}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(37,99,235,0.4)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; }}
                >
                  <span style={{ flex: "none", fontSize: "15px" }}>🔀</span>
                  <div style={rowMain}>
                    <div style={{ ...rowTitle, fontSize: "14px" }}>{String(tpl.name)}</div>
                    <div style={rowSub}>版本 {String(tpl.version)} · {Array.isArray(tpl.nodes) ? String(tpl.nodes.length) + " 节点" : ""} · 首节点 {String(tpl.firstNode)} · {Array.isArray(tpl.nodes) ? (tpl.nodes as Array<Record<string, unknown>>).filter((n) => n.requiresApproval === true).length + " 个需审批" : ""}</div>
                  </div>
                  <button
                    type="button"
                    style={{ flex: "none", fontSize: "12px", padding: "2px 10px", borderRadius: "999px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", background: "transparent", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #444)", fontFamily: "inherit" }}
                    onClick={(e) => { e.stopPropagation(); exportTemplateFile(tpl); }}
                  >
                    导出
                  </button>
                  <span style={{ flex: "none", fontSize: "13px", color: "#2563eb" }}>编辑 ›</span>
                </div>
              ))}
            </div>
          )}
          {templateList !== null && templateList.projectFiles.length > 0 ? (
            <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "10px", border: "1px dashed var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" }}>项目文件模板（.workbench-templates/）</div>
              <div style={hint}>这些文件可通过 workflow_template_sync_project 同步进运行时模板库：</div>
              {templateList.projectFiles.map((f, i) => (
                <div key={"pf" + i} style={{ fontSize: "12px", color: "var(--dsw-alias-label-secondary, #444)", padding: "2px 0" }}><code>{String(f)}</code></div>
              ))}
            </div>
          ) : null}
        </div>
      ) : tab === "roles" ? (
        <div style={page}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
            <span style={sectionTitle}>工作流角色库</span>
            <span style={hint}>角色 = 节点契约模板（职责 / 上游产物 / 输出产物）· 节点绑定固定版本 · 保存计入 ui-editor 审计</span>
            <span style={{ flex: 1 }} />
            <label style={{ ...pill("var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", "var(--dsw-alias-label-secondary, #444)"), display: "inline-block", cursor: "pointer" }}>
              导入 JSON
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                key={fileInputKey("role")}
                onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) importRoleFile(f); e.currentTarget.value = ""; }}
              />
            </label>
            <button type="button" style={pill("rgba(37,99,235,0.6)", "#2563eb")} onClick={() => openRoleEditor(null)}>＋ 新建角色</button>
          </div>
          {rolesList === null ? (
            <div style={empty}>加载中…</div>
          ) : rolesList.roles.length === 0 ? (
            <div style={empty}>暂无角色，点右上角"＋ 新建角色"创建第一个。</div>
          ) : (
            <div style={listWrap}>
              {rolesList.roles.map((role, i) => (
                <div
                  key={"rl" + i}
                  style={{ ...row, cursor: "pointer", border: "1px solid transparent", alignItems: "flex-start" }}
                  onClick={() => openRoleEditor(role)}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(37,99,235,0.4)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; }}
                >
                  <span style={{ flex: "none", fontSize: "15px" }}>🎭</span>
                  <div style={rowMain}>
                    <div style={{ ...rowTitle, fontSize: "14px" }}>{String(role.name)} <span style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" }}>v{String(role.version)}</span></div>
                    <div style={rowSub}>{String(role.description)}</div>
                    <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
                      {Array.isArray(role.inputs) && (role.inputs as Array<Record<string, unknown>>).length > 0 ? (
                        <span style={{ fontSize: "10px", padding: "1px 8px", borderRadius: "999px", color: "#6d28d9", background: "rgba(109,40,217,0.10)" }}>↑ 收 {Array.isArray(role.inputs) ? (role.inputs as Array<Record<string, unknown>>).map((a) => String(a.id)).join(", ") : ""}</span>
                      ) : null}
                      {Array.isArray(role.outputs) && (role.outputs as Array<Record<string, unknown>>).length > 0 ? (
                        <span style={{ fontSize: "10px", padding: "1px 8px", borderRadius: "999px", color: "#166534", background: "rgba(22,163,74,0.12)" }}>↓ 出 {Array.isArray(role.outputs) ? (role.outputs as Array<Record<string, unknown>>).map((a) => String(a.id)).join(", ") : ""}</span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    style={{ flex: "none", fontSize: "12px", padding: "2px 10px", borderRadius: "999px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", background: "transparent", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #444)", fontFamily: "inherit" }}
                    onClick={(e) => { e.stopPropagation(); exportRoleFile(role); }}
                  >
                    导出
                  </button>
                  <span style={{ flex: "none", fontSize: "13px", color: "#2563eb" }}>编辑 ›</span>
                </div>
              ))}
            </div>
          )}
          {rolesList !== null && rolesList.projectFiles.length > 0 ? (
            <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "10px", border: "1px dashed var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" }}>项目角色文件（.workbench-roles/）</div>
              <div style={hint}>这些文件可通过 workflow_role_sync_project 同步进运行时角色库：</div>
              {rolesList.projectFiles.map((f, i) => (
                <div key={"pfr" + i} style={{ fontSize: "12px", color: "var(--dsw-alias-label-secondary, #444)", padding: "2px 0" }}><code>{String(f)}</code></div>
              ))}
            </div>
          ) : null}
        </div>
      ) : tab === "runs" ? (
        <div style={page}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
            <span style={sectionTitle}>运行记录</span>
            <span style={hint}>{runsList !== null ? runsList.length + " 条运行" : ""} · 点击运行查看详情与产物</span>
            {runDetail !== null ? (
              <button type="button" style={pill("var(--dsw-alias-stroke-divider, rgba(127,127,127,0.35))", "var(--dsw-alias-label-secondary, #444)")} onClick={() => setRunDetail(null)}>收起详情</button>
            ) : null}
          </div>
          {runsList === null ? (
            <div style={empty}>加载中…</div>
          ) : runsList.length === 0 ? (
            <div style={empty}>还没有运行。对话中调用 workflow_start 创建第一条。</div>
          ) : (
            <div style={listWrap}>
              {runsList.map((run, i) => (
                <div
                  key={"rl" + i}
                  style={{ ...row, cursor: "pointer", border: "1px solid transparent" }}
                  onClick={() => fetchRunDetail(String(run.runId ?? ""))}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(37,99,235,0.4)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; }}
                >
                  <span style={runStatusChip(run.status)}>{statusText(run.status) ?? String(run.status)}</span>
                  <div style={rowMain}>
                    <div style={rowTitle}>{String(run.workflow)}</div>
                    <div style={rowSub}>{String(run.runId)} · 当前节点 {run.current === null || run.current === undefined || run.current === "" ? "—" : String(run.current)} · 启动于 {fmt(run.startedAt)}</div>
                  </div>
                  <span style={{ flex: "none", fontSize: "13px", color: "#2563eb" }}>详情 ›</span>
                </div>
              ))}
            </div>
          )}
          {runDetail !== null ? (
            <div style={{ marginTop: "16px", padding: "14px 16px", borderRadius: "10px", border: "1px solid rgba(37,99,235,0.25)", background: "rgba(37,99,235,0.04)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <span style={sectionTitle}>{String((runDetail.run as Record<string, unknown> | null)?.workflow ?? "")}</span>
                <span style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" }}>{String((runDetail.run as Record<string, unknown> | null)?.runId ?? runDetail.runId ?? "")}</span>
                <span style={{ flex: 1 }} />
                <span style={runStatusChip((runDetail.run as Record<string, unknown> | null)?.status ?? runDetail.status)}>{statusText((runDetail.run as Record<string, unknown> | null)?.status ?? runDetail.status) ?? "—"}</span>
              </div>
              {Array.isArray(runDetail.artifacts) && (runDetail.artifacts as Array<Record<string, unknown>>).length > 0 ? (
                <div style={{ marginTop: "8px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" }}>产物（{(runDetail.artifacts as Array<Record<string, unknown>>).length}）</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {(runDetail.artifacts as Array<Record<string, unknown>>).map((a, ai) => (
                      <div key={"rda" + ai} style={{ ...row, cursor: "pointer", alignItems: "center" }} onClick={() => goToArtifactFromRun(runDetail, a)}>
                        <span style={{ flex: "none", fontSize: "10px", padding: "1px 8px", borderRadius: "999px", color: "#166534", background: "rgba(22,163,74,0.12)" }}>v{String(a.version ?? "?")}</span>
                        <div style={rowMain}>
                          <div style={{ fontSize: "12px", fontWeight: 600 }}>{String(a.artifactId ?? "")}</div>
                          <div style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" }}>{String(a.nodeId ?? "")} · {String(a.path ?? "")} · {String(a.size ?? 0)} B</div>
                        </div>
                        <span style={{ flex: "none", fontSize: "12px", color: "#2563eb" }}>查看 ›</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {Array.isArray(runDetail.events) && (runDetail.events as Array<Record<string, unknown>>).length > 0 ? (
                <div style={{ marginTop: "10px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" }}>审计事件（{(runDetail.events as Array<Record<string, unknown>>).length}）</div>
                  <div style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", lineHeight: "1.9", fontFamily: "ui-monospace, monospace" }}>
                    {(runDetail.events as Array<Record<string, unknown>>).slice(-12).map((ev, ei) => (
                      <div key={"rde" + ei} style={{ display: "flex", gap: "8px" }}>
                        <span style={{ flex: "none", color: "#2563eb" }}>#{String(ev.seq ?? "")}</span>
                        <span style={{ flex: "none", color: "#6d28d9" }}>{String(ev.actor ?? "")}</span>
                        <span>{String(ev.action ?? "")}{ev.nodeId !== null && ev.nodeId !== undefined && ev.nodeId !== "" ? " · " + String(ev.nodeId) : ""}</span>
                        <span style={{ marginLeft: "auto" }}>{fmt(ev.ts)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <ArtifactsTab
          list={artifactsList}
          filter={artifactFilter}
          setFilter={setArtifactFilter}
          status={artifactStatus}
          setStatus={setArtifactStatus}
          selected={selectedArtifact}
          onSelect={openArtifact}
          detail={artifactDetail}
          diff={artifactDiff}
          onDiff={openArtifactDiff}
          onCloseDiff={() => setArtifactDiff(null)}
          onOpenRun={(runId) => { setTab("runs"); fetchRunDetail(runId); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 产物模块（ArtifactsTab）：跨 run 产物列表 + 详情双栏；MD/JSON/图片渲染、
// 漂移标识、版本历史与版本 Diff、下载/复制、跳转运行记录。
// ---------------------------------------------------------------------------

function shortHash(h: unknown): string {
  const s = typeof h === "string" ? h : "";
  return s.length > 10 ? s.slice(0, 10) + "…" : s || "—";
}

function artifactStatusOf(row: Record<string, unknown>): "ok" | "drifted" | "missing" {
  if (row.invalidPath === true) return "missing";
  if (row.exists === false) return "missing";
  if (row.drifted === true) return "drifted";
  return "ok";
}

function downloadArtifact(detail: Record<string, unknown>): void {
  const content = detail.content;
  if (typeof content !== "string") return;
  const mime = String(detail.mime ?? "application/octet-stream");
  const path = String(detail.path ?? "artifact");
  const name = path.split("/").pop() || "artifact";
  let bytes: Uint8Array;
  if (detail.contentEncoding === "base64") {
    const bin = atob(content);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(content);
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function copyTextToClipboard(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function ArtifactBody({ detail }: { detail: Record<string, unknown> }) {
  const mime = String(detail.mime ?? "text/plain");
  const path = String(detail.path ?? "");
  const content = typeof detail.content === "string" ? detail.content : null;
  const truncated = detail.truncated === true;

  if (mime.startsWith("image/") && content !== null) {
    return (
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <img src={"data:" + mime + ";base64," + content} alt={path} style={{ maxWidth: "100%", maxHeight: "46vh", borderRadius: "10px" }} />
      </div>
    );
  }
  if (mime === "text/markdown" && content !== null) {
    return <div className="workbench-artifact-md"><MarkdownText text={content} /></div>;
  }
  if (mime === "application/json" && content !== null && !truncated) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return <JsonBlock label={path} payload={parsed} defaultOpen />;
    } catch {
      /* fall through to plain pre */
    }
  }
  if (content !== null) {
    return (
      <pre style={{ margin: 0, fontSize: "12px", lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary, #222)" }}>
        {content}
        {truncated ? "\n\n…（内容过大，已截断显示）" : ""}
      </pre>
    );
  }
  return (
    <div style={{ padding: "32px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" }}>
      该文件为二进制 / 大文件，不支持内联预览，可下载查看。
    </div>
  );
}

function ArtifactsTab(props: {
  list: Array<Record<string, unknown>> | null;
  filter: string;
  setFilter: (v: string) => void;
  status: "all" | "ok" | "drifted" | "missing";
  setStatus: (v: "all" | "ok" | "drifted" | "missing") => void;
  selected: Record<string, unknown> | null;
  onSelect: (row: Record<string, unknown>, version?: number) => void;
  detail: Record<string, unknown> | null;
  diff: Record<string, unknown> | null;
  onDiff: (version: number, against: number) => void;
  onCloseDiff: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const { list, filter, setFilter, status, setStatus, selected, onSelect, detail, diff, onDiff, onCloseDiff, onOpenRun } = props;
  const input: React.CSSProperties = { fontSize: "12px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))", background: "var(--dsw-alias-bg-module-strong, #fff)", color: "var(--dsw-alias-label-primary, #222)", fontFamily: "inherit", outline: "none" };
  const chipBtn = (active: boolean): React.CSSProperties => ({ fontSize: "11px", padding: "3px 10px", borderRadius: "999px", border: "1px solid " + (active ? "rgba(37,99,235,0.8)" : "var(--dsw-alias-stroke-divider, rgba(127,127,127,0.3))"), color: active ? "#2563eb" : "var(--dsw-alias-label-secondary, #444)", background: active ? "rgba(37,99,235,0.08)" : "transparent", cursor: "pointer", fontFamily: "inherit" });
  const statusChip = (s: "ok" | "drifted" | "missing"): { text: string; fg: string; bg: string } =>
    s === "ok" ? { text: "正常", fg: "#166534", bg: "rgba(22,163,74,0.14)" } : s === "drifted" ? { text: "漂移", fg: "#b45309", bg: "rgba(217,119,6,0.16)" } : { text: "缺失", fg: "#b91c1c", bg: "rgba(185,28,28,0.12)" };

  const kw = filter.trim().toLowerCase();
  const filtered = (list ?? []).filter((row) => {
    if (status !== "all" && artifactStatusOf(row) !== status) return false;
    if (kw === "") return true;
    const hay = String(row.path ?? "") + " " + String(row.artifactId ?? "") + " " + String(row.runId ?? "") + " " + String(row.workflow ?? "") + " " + String(row.nodeId ?? "");
    return hay.toLowerCase().includes(kw);
  });

  const driftCount = (list ?? []).filter((r) => artifactStatusOf(r) === "drifted").length;
  const missingCount = (list ?? []).filter((r) => artifactStatusOf(r) === "missing").length;

  const versions: Array<Record<string, unknown>> = detail !== null && Array.isArray(detail.versions) ? (detail.versions as Array<Record<string, unknown>>) : [];
  const detailStatus = detail !== null ? artifactStatusOf(detail as unknown as Record<string, unknown>) : null;
  const isTextArtifact = detail !== null && !(detail.binary === true);

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* ---- 左：列表 ---- */}
      <div style={{ width: 310, flex: "none", borderRight: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.15))", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.12))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
            <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" }}>全部产物</span>
            <span style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" }}>
              {list !== null ? list.length + " 个" : ""}
              {driftCount > 0 ? " · " + driftCount + " 漂移" : ""}
              {missingCount > 0 ? " · " + missingCount + " 缺失" : ""}
            </span>
          </div>
          <input style={{ ...input, width: "100%" }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜索路径 / 产物名 / runId…" />
          <div style={{ display: "flex", gap: "4px", marginTop: "8px", flexWrap: "wrap" }}>
            {([["all", "全部"], ["ok", "正常"], ["drifted", "漂移"], ["missing", "缺失"]] as Array<["all" | "ok" | "drifted" | "missing", string]>).map(([k, label]) => (
              <button key={k} type="button" style={chipBtn(status === k)} onClick={() => setStatus(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {list === null ? (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" }}>加载中…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" }}>暂无匹配的产物</div>
          ) : (
            filtered.map((row, i) => {
              const s = artifactStatusOf(row);
              const cs = statusChip(s);
              const active = selected !== null && String(row.runId ?? "") === String(selected.runId ?? "") && String(row.artifactId ?? "") === String(selected.artifactId ?? "") && String(row.nodeId ?? "") === String(selected.nodeId ?? "");
              return (
                <div
                  key={"ar" + i}
                  style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "8px", cursor: "pointer", border: "1px solid " + (active ? "rgba(37,99,235,0.55)" : "transparent"), background: active ? "rgba(37,99,235,0.07)" : "rgba(127,127,127,0.05)" }}
                  onClick={() => onSelect(row)}
                >
                  <span style={{ flex: "none", fontSize: "9px", padding: "1px 7px", borderRadius: "999px", color: cs.fg, background: cs.bg }}>{cs.text}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(row.path ?? row.artifactId ?? "")}</div>
                    <div style={{ fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(row.workflow ?? "")} · {String(row.nodeId ?? "")} · v{String(row.version ?? "?")}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ---- 右：详情 ---- */}
      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "16px 20px" }}>
        {detail === null ? (
          <div style={{ padding: "48px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" }}>
            {selected === null ? "在左侧选择一个产物查看详情。" : "加载中…"}
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary, #222)", wordBreak: "break-all" }}>{String(detail.path ?? "")}</span>
              {detailStatus !== null ? (() => { const cs = statusChip(detailStatus); return <span style={{ fontSize: "10px", padding: "2px 10px", borderRadius: "999px", color: cs.fg, background: cs.bg }}>{cs.text}</span>; })() : null}
              {detail.binary === true ? <span style={{ fontSize: "10px", padding: "2px 10px", borderRadius: "999px", color: "#6d28d9", background: "rgba(109,40,217,0.10)" }}>二进制</span> : null}
            </div>
            <div style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", marginTop: "4px" }}>
              {String(detail.runId ?? "")} · 节点 {String(detail.nodeId ?? "")} · 产物 {String(detail.artifactId ?? "")} · v{String(detail.version ?? "?")}
            </div>

            {/* 漂移提示 */}
            {detail.drifted === true ? (
              <div style={{ marginTop: "10px", padding: "10px 14px", borderRadius: "8px", background: "rgba(217,119,6,0.12)", border: "1px solid rgba(217,119,6,0.35)", fontSize: "12px", color: "#92400e" }}>
                ⚠ 磁盘内容与登记的版本不一致（sha256 已变化）：登记 {shortHash(detail.registeredSha256)}，当前 {shortHash(detail.currentSha256)}。文件在节点完成后被改动过。
              </div>
            ) : detailStatus === "missing" ? (
              <div style={{ marginTop: "10px", padding: "10px 14px", borderRadius: "8px", background: "rgba(185,28,28,0.08)", border: "1px solid rgba(185,28,28,0.3)", fontSize: "12px", color: "#991b1b" }}>
                ✗ 登记时存在，但磁盘上的文件已不存在（或路径越界）。
              </div>
            ) : null}

            {/* 元信息 + 操作 */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", margin: "12px 0" }}>
              <button type="button" style={chipBtn(false)} onClick={() => downloadArtifact(detail)} disabled={typeof detail.content !== "string"}>⬇ 下载</button>
              {isTextArtifact && typeof detail.content === "string" ? (
                <button type="button" style={chipBtn(false)} onClick={() => copyTextToClipboard(String(detail.content))}>⧉ 复制原文</button>
              ) : null}
              <button type="button" style={chipBtn(false)} onClick={() => onOpenRun(String(detail.runId ?? ""))}>→ 在运行记录中查看</button>
            </div>

            <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", marginBottom: "12px" }}>
              <span>登记 sha256：<code>{shortHash(detail.registeredSha256)}</code></span>
              <span>当前 sha256：<code>{shortHash(detail.currentSha256)}</code></span>
              <span>大小：{String(detail.currentSize ?? detail.size ?? "?")} B</span>
              <span>{detail.truncated === true ? "内容已截断 · " : ""}mime：{String(detail.mime ?? "?")}</span>
            </div>

            {/* 版本历史 */}
            {versions.length > 0 ? (
              <div style={{ marginBottom: "12px", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--dsw-alias-stroke-divider, rgba(127,127,127,0.2))", background: "rgba(127,127,127,0.04)" }}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #444)", marginBottom: "6px" }}>版本历史（{versions.length}）</div>
                {[...versions].reverse().map((v, i) => {
                  const vn = Number(v.version ?? 0);
                  return (
                    <div key={"vv" + i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "3px 0", fontSize: "12px" }}>
                      <span style={{ flex: "none", fontSize: "10px", padding: "1px 8px", borderRadius: "999px", color: "#166534", background: "rgba(22,163,74,0.12)" }}>v{vn}</span>
                      <span style={{ flex: "none", color: "var(--dsw-alias-label-tertiary, #999)" }}><code>{shortHash(v.sha256)}</code></span>
                      <span style={{ flex: "none", color: "var(--dsw-alias-label-tertiary, #999)" }}>{String(v.registeredAt ?? "").replace("T", " ").slice(0, 19)}</span>
                      {v.hasSnapshot === true ? <span style={{ flex: "none", fontSize: "10px", color: "#6d28d9" }}>快照</span> : null}
                      <span style={{ flex: 1 }} />
                      <button type="button" style={chipBtn(false)} onClick={() => onSelect(selected as Record<string, unknown>, vn)}>查看</button>
                      {vn > 1 && isTextArtifact ? (
                        <button type="button" style={chipBtn(false)} onClick={() => onDiff(vn, vn - 1)}>对比 v{vn - 1}</button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Diff 区 */}
            {diff !== null ? (
              <div style={{ marginBottom: "12px", padding: "12px 14px", borderRadius: "8px", border: "1px solid rgba(37,99,235,0.3)", background: "rgba(37,99,235,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" }}>
                    版本对比：v{String((diff.from as Record<string, unknown> | null)?.version ?? "?")} → v{String((diff.to as Record<string, unknown> | null)?.version ?? "?")}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={chipBtn(false)} onClick={onCloseDiff}>关闭对比</button>
                </div>
                {diff.status === "no-snapshot" ? (
                  <div style={{ fontSize: "12px", color: "#92400e", padding: "6px 0" }}>部分版本没有内容快照（旧版本或二进制文件），无法生成差异。</div>
                ) : (
                  <DiffBlock
                    diffs={[{ path: String(diff.path ?? ""), oldText: String((diff.from as Record<string, unknown> | null)?.content ?? ""), newText: String((diff.to as Record<string, unknown> | null)?.content ?? "") }]}
                    maxLines={24}
                  />
                )}
              </div>
            ) : null}

            {/* 内容主体 */}
            <ArtifactBody detail={detail} />
          </div>
        )}
      </div>
    </div>
  );
}

function WorkbenchSidebarAction() {
  const [open, setOpen] = React.useState(false);
  const button: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "6px 8px", fontSize: "13px", lineHeight: "20px", background: "transparent", border: "0", borderRadius: "6px", color: "var(--dsw-alias-label-secondary, #444)", cursor: "pointer", fontFamily: "inherit", textAlign: "left" };
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <button type="button" style={button} onClick={() => setOpen(!open)}>
        <span>⚙ 工作台</span>
        <span style={{ marginLeft: "auto", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" }}>全屏</span>
      </button>
      {open ? <WorkbenchHub onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const inject = ["slots", "conversationEvents"];

function apply(ctx: any): void {
  // 1. keyed tool-view cards
  for (const toolName of GOVERNANCE_TOOLS) {
    let Component: React.ComponentType<{ block?: unknown; toolName?: unknown }> = WorkbenchToolCard;
    if (toolName === "workflow_approval_inbox") Component = WorkbenchInboxCard;
    if (toolName === "workflow_start" || toolName === "workflow_advance") Component = WorkbenchRunMapCard;
    if (toolName === "workflow_editor") Component = WorkbenchEditorCard;
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register({ name: "tool.call.toolview", key: toolName }, Component),
    );
  }
  // 2. conversation definition surfaces
  ctx.conversationEvents.register(workbenchRunDefinition);
  ctx.slots.inject("conversation.chat.turnTail", () =>
    ctx.slots.register({ name: "conversation.chat.turnTail", select: selectWorkbenchActivity }, WorkbenchActivityStrip),
  );
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register({ name: "conversation.chat.node", key: "workbench-run" }, WorkbenchRunNodeCard),
  );
  // 3. sidebar footer anchor
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: "workbench-panel" }, WorkbenchSidebarAction),
  );
}

const name = "workbench-ui";

export { apply, inject, name };
