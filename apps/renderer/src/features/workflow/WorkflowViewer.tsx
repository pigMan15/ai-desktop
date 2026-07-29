import { useEffect, useState } from "react";

import type {
  CompiledWorkflowSummary,
  RuntimeWorkbenchState,
  WorkflowDefinitionSummary,
  WorkflowExportFormat,
  WorkflowSimulation,
  WorkflowVersionDiff,
  WorkflowVersionSummary,
} from "../../app/runtimeClient";

type Props = {
  state: RuntimeWorkbenchState | null;
  workflow?: WorkflowDefinitionSummary | null;
  compiled?: CompiledWorkflowSummary | null;
  simulation?: WorkflowSimulation | null;
  history?: WorkflowVersionSummary[];
  diff?: WorkflowVersionDiff | null;
  onSaveDefinition?: (definition: WorkflowDefinitionSummary) => void;
  onSimulate?: () => void;
  onCompareVersion?: (workflowVersionId: string) => void;
  onExportWorkflow?: (format: WorkflowExportFormat) => void;
};

export function WorkflowViewer({
  state,
  workflow = null,
  compiled = null,
  simulation = null,
  history = [],
  diff = null,
  onSaveDefinition,
  onSimulate,
  onCompareVersion,
  onExportWorkflow,
}: Props) {
  const projection = state?.projection;
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [newNodeId, setNewNodeId] = useState("");
  const [newNodeName, setNewNodeName] = useState("");
  const [newNodeKind, setNewNodeKind] = useState("task");
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");
  const [exportFormat, setExportFormat] = useState<WorkflowExportFormat>("canonical-json");
  const editableWorkflow = parseWorkflowDraft(draft);

  useEffect(() => {
    setDraft(workflow ? JSON.stringify(workflow, null, 2) : "");
    setDraftError(null);
  }, [workflow]);

  function saveDraft() {
    try {
      const parsed = JSON.parse(draft) as WorkflowDefinitionSummary;
      setDraftError(null);
      onSaveDefinition?.(parsed);
    } catch {
      setDraftError("工作流定义不是有效 JSON，无法保存新版本。");
    }
  }

  function updateDraft(mutator: (definition: WorkflowDefinitionSummary) => WorkflowDefinitionSummary) {
    const definition = parseWorkflowDraft(draft);
    if (!definition) {
      setDraftError("工作流定义不是有效 JSON，无法进行图形编辑。");
      return;
    }
    setDraft(JSON.stringify(mutator(definition), null, 2));
    setDraftError(null);
  }

  function addNode() {
    const id = newNodeId.trim();
    const name = newNodeName.trim();
    if (!id || !name) {
      setDraftError("请输入节点 ID 和节点名称。");
      return;
    }
    if (editableWorkflow?.nodes.some((node) => node.id === id)) {
      setDraftError(`节点 ID “${id}” 已存在。`);
      return;
    }
    updateDraft((definition) => ({
      ...definition,
      nodes: [...definition.nodes, { id, name, kind: newNodeKind }],
    }));
    setNewNodeId("");
    setNewNodeName("");
    setNewNodeKind("task");
  }

  function removeNode(nodeId: string) {
    updateDraft((definition) => ({
      ...definition,
      nodes: definition.nodes.filter((node) => node.id !== nodeId),
      edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
  }

  function addEdge() {
    if (!edgeFrom || !edgeTo) {
      setDraftError("请选择连线起点和终点。");
      return;
    }
    if (edgeFrom === edgeTo) {
      setDraftError("连线起点和终点不能相同。");
      return;
    }
    if (editableWorkflow?.edges.some((edge) => edge.from === edgeFrom && edge.to === edgeTo)) {
      setDraftError("该连线已存在。");
      return;
    }
    updateDraft((definition) => {
      const baseId = `edge-${edgeFrom}-${edgeTo}`;
      const nextId = uniqueEdgeId(baseId, definition.edges.map((edge) => edge.id));
      return {
        ...definition,
        edges: [...definition.edges, { id: nextId, from: edgeFrom, to: edgeTo }],
      };
    });
    setEdgeFrom("");
    setEdgeTo("");
  }

  function removeEdge(edgeId: string) {
    updateDraft((definition) => ({
      ...definition,
      edges: definition.edges.filter((edge) => edge.id !== edgeId),
    }));
  }

  return (
    <section id="workflow" className="panel" aria-labelledby="workflow-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">工作流</p>
          <h2 id="workflow-title">工作流视图</h2>
        </div>
        <span className="status-pill">{projection?.status ?? "尚未创建 Run"}</span>
      </div>
      {!projection ? (
        <p className="body-copy">
          尚未创建 Run。工作流定义和编译诊断仍可在此审查，运行状态会在创建 Run 后显示。
        </p>
      ) : (
        <>
          <p className="body-copy">当前 Run：{projection.runId}</p>
          <div className="table-like" role="table" aria-label="工作流节点状态">
            <div role="row" className="table-row table-head">
              <span role="columnheader">节点</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">当前执行</span>
            </div>
            {Object.entries(projection.nodeStates).map(([nodeId, nodeState]) => (
              <div role="row" className="table-row" key={nodeId}>
                <span role="cell">{nodeId}</span>
                <span role="cell">{nodeState}</span>
                <span role="cell">{projection.currentNodeIds.includes(nodeId) ? "是" : "否"}</span>
              </div>
            ))}
          </div>
          <ul className="compact-list" aria-label="工作流阻塞原因">
            {projection.blockingReasons.length === 0 ? (
              <li>暂无阻塞原因</li>
            ) : (
              projection.blockingReasons.map((reason) => (
                <li key={`${reason.code}-${reason.nodeId ?? ""}`}>
                  {reason.code}：{reason.message}
                </li>
              ))
            )}
          </ul>
        </>
      )}
      {workflow ? (
        <>
          <div className="panel-heading">
            <strong>{workflow.name}</strong>
            <span className="status-pill">版本 {workflow.version}</span>
          </div>
          <div className="table-like" role="table" aria-label="工作流定义节点">
            <div role="row" className="table-row table-head">
              <span role="columnheader">节点</span>
              <span role="columnheader">名称</span>
              <span role="columnheader">类型</span>
            </div>
            {workflow.nodes.map((node) => (
              <div role="row" className="table-row" key={node.id}>
                <span role="cell">{node.id}</span>
                <span role="cell">{node.name}</span>
                <span role="cell">{node.kind}</span>
              </div>
            ))}
          </div>
          <div className="panel-heading">
            <strong>可视化编辑</strong>
            <span className="status-pill">{editableWorkflow ? "草稿可编辑" : "JSON 有错误"}</span>
          </div>
          {editableWorkflow ? (
            <>
              <div className="table-like" role="list" aria-label="工作流图节点">
                {editableWorkflow.nodes.map((node) => (
                  <div className="table-row" role="listitem" key={node.id}>
                    <span>
                      <strong>{node.name}</strong> · {node.id} · {node.kind}
                    </span>
                    <button
                      className="quiet-button"
                      aria-label={`删除节点 ${node.id}`}
                      onClick={() => removeNode(node.id)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div className="form-grid">
                <label>
                  新节点 ID
                  <input value={newNodeId} onChange={(event) => setNewNodeId(event.target.value)} />
                </label>
                <label>
                  新节点名称
                  <input value={newNodeName} onChange={(event) => setNewNodeName(event.target.value)} />
                </label>
                <label>
                  新节点类型
                  <select value={newNodeKind} onChange={(event) => setNewNodeKind(event.target.value)}>
                    {NODE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button className="quiet-button" onClick={addNode}>
                  新增节点
                </button>
              </div>
              <div className="form-grid">
                <label>
                  连线起点
                  <select value={edgeFrom} onChange={(event) => setEdgeFrom(event.target.value)}>
                    <option value="">选择节点</option>
                    {editableWorkflow.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name} · {node.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  连线终点
                  <select value={edgeTo} onChange={(event) => setEdgeTo(event.target.value)}>
                    <option value="">选择节点</option>
                    {editableWorkflow.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name} · {node.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button className="quiet-button" onClick={addEdge}>
                  新增连线
                </button>
              </div>
              <ul className="compact-list" aria-label="工作流图连线">
                {editableWorkflow.edges.length === 0 ? (
                  <li>暂无连线</li>
                ) : (
                  editableWorkflow.edges.map((edge) => (
                    <li key={edge.id}>
                      {edge.from} → {edge.to}
                      <button
                        className="quiet-button"
                        aria-label={`删除连线 ${edge.id}`}
                        onClick={() => removeEdge(edge.id)}
                      >
                        删除
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </>
          ) : null}
          <div className="form-grid">
            <label className="form-wide">
              工作流定义 JSON
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={18}
                spellCheck={false}
              />
            </label>
            <label>
              比较版本
              <select
                value={diff?.fromVersionId ?? ""}
                onChange={(event) => {
                  if (event.target.value) {
                    onCompareVersion?.(event.target.value);
                  }
                }}
                disabled={history.length === 0 || !onCompareVersion}
              >
                <option value="">选择版本</option>
                {history.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.version} · {version.createdAt}
                  </option>
                ))}
              </select>
            </label>
            <label>
              导出格式
              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as WorkflowExportFormat)}
                disabled={!onExportWorkflow}
              >
                <option value="canonical-json">Canonical JSON</option>
                <option value="generic-yaml">Generic YAML</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button
              className="quiet-button"
              disabled={!onSimulate}
              onClick={onSimulate}
            >
              模拟版本
            </button>
            <button
              className="quiet-button"
              disabled={!draft.trim() || !onSaveDefinition}
              onClick={saveDraft}
            >
              保存新版本
            </button>
            <button
              className="quiet-button"
              onClick={() => setDraft(JSON.stringify(workflow, null, 2))}
            >
              重置草稿
            </button>
            <button
              className="quiet-button"
              disabled={!onExportWorkflow}
              onClick={() => onExportWorkflow?.(exportFormat)}
            >
              导出工作流
            </button>
          </div>
          {draftError ? <p className="body-copy">{draftError}</p> : null}
          {simulation ? (
            <>
              <div className="panel-heading">
                <strong>模拟结果</strong>
                <span className="status-pill">
                  {simulation.status === "ready" ? "可运行" : "存在阻塞"}
                </span>
              </div>
              <ul className="compact-list" aria-label="工作流模拟步骤">
                {simulation.steps.map((step) => (
                  <li key={step.nodeId}>
                    {step.nodeId}：{step.state}
                  </li>
                ))}
              </ul>
              {simulation.diagnostics.length > 0 ? (
                <ul className="compact-list" aria-label="工作流模拟诊断">
                  {simulation.diagnostics.map((diagnostic) => (
                    <li key={`${diagnostic.code}-${diagnostic.edgeId ?? diagnostic.nodeId ?? ""}`}>
                      {diagnostic.code}：{diagnostic.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {diff ? (
            <>
              <div className="panel-heading">
                <strong>版本差异</strong>
                <span className="status-pill">结构化比较</span>
              </div>
              <ul className="compact-list" aria-label="工作流版本差异">
                {diff.changedNodes.map((node) => (
                  <li key={`node-${node.id}`}>
                    {node.id}：{formatChanges(node.changes)}
                  </li>
                ))}
                {diff.addedNodes.map((node) => (
                  <li key={`added-node-${String(node.id)}`}>新增节点：{String(node.id)}</li>
                ))}
                {diff.removedNodes.map((node) => (
                  <li key={`removed-node-${String(node.id)}`}>删除节点：{String(node.id)}</li>
                ))}
                {diff.changedEdges.map((edge) => (
                  <li key={`edge-${edge.id}`}>
                    连线 {edge.id}：{formatChanges(edge.changes)}
                  </li>
                ))}
                {diff.addedEdges.map((edge) => (
                  <li key={`added-edge-${String(edge.id)}`}>新增连线：{String(edge.id)}</li>
                ))}
                {diff.removedEdges.map((edge) => (
                  <li key={`removed-edge-${String(edge.id)}`}>删除连线：{String(edge.id)}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
      {compiled ? (
        <ul className="compact-list" aria-label="工作流编译诊断">
          {compiled.diagnostics.length === 0 ? (
            <li>编译诊断通过</li>
          ) : (
            compiled.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}-${diagnostic.edgeId ?? diagnostic.nodeId ?? ""}`}>
                {diagnostic.code}：{diagnostic.message}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}

function formatChanges(changes: Record<string, { from: unknown; to: unknown }>) {
  return Object.entries(changes)
    .map(([field, change]) => `${fieldLabel(field)}从“${formatValue(change.from)}”变为“${formatValue(change.to)}”`)
    .join("；");
}

function fieldLabel(field: string) {
  return (
    {
      name: "名称",
      description: "说明",
      kind: "类型",
      role: "角色",
      requires: "前置要求",
      gates: "门禁",
      metadata: "元数据",
      from: "起点",
      to: "终点",
      condition: "条件",
      trigger: "触发器",
    }[field] ?? field
  );
}

function formatValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
}

function parseWorkflowDraft(draft: string): WorkflowDefinitionSummary | null {
  try {
    return draft ? (JSON.parse(draft) as WorkflowDefinitionSummary) : null;
  } catch {
    return null;
  }
}

function uniqueEdgeId(baseId: string, existingIds: string[]) {
  const existing = new Set(existingIds);
  if (!existing.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (existing.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

const NODE_KINDS = ["task", "agent", "approval", "gate", "evidence", "deploy", "report", "composite"];
