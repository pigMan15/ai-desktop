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
  workflowVersionId?: string;
  onSaveDefinition?: (definition: WorkflowDefinitionSummary) => Promise<void> | void;
  onSimulate?: () => void;
  onCompareVersion?: (workflowVersionId: string) => void;
  onRestoreVersion?: (workflowVersionId: string) => void;
  onExportWorkflow?: (format: WorkflowExportFormat) => void;
};

export function WorkflowViewer({
  state,
  workflow = null,
  compiled = null,
  simulation = null,
  history = [],
  diff = null,
  workflowVersionId,
  onSaveDefinition,
  onSimulate,
  onCompareVersion,
  onRestoreVersion,
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
  const [selectedHistoryVersionId, setSelectedHistoryVersionId] = useState("");
  const [exportFormat, setExportFormat] = useState<WorkflowExportFormat>("canonical-json");
  const editableWorkflow = parseWorkflowDraft(draft);
  const draftStorageKey = workflowVersionId ? `workflow-draft:${workflowVersionId}` : null;
  const selectedHistoryVersion = history.find((version) => version.id === selectedHistoryVersionId);

  useEffect(() => {
    const storedDraft = draftStorageKey ? window.sessionStorage.getItem(draftStorageKey) : null;
    setDraft(storedDraft ?? (workflow ? JSON.stringify(workflow, null, 2) : ""));
    setDraftError(null);
    setSelectedHistoryVersionId("");
  }, [draftStorageKey, workflow]);

  function updateStoredDraft(value: string) {
    setDraft(value);
    if (draftStorageKey) {
      window.sessionStorage.setItem(draftStorageKey, value);
    }
  }

  async function saveDraft() {
    let parsed: WorkflowDefinitionSummary;
    try {
      parsed = JSON.parse(draft) as WorkflowDefinitionSummary;
    } catch {
      setDraftError("工作流定义不是有效 JSON，无法保存新版本。");
      return;
    }
    try {
      setDraftError(null);
      await onSaveDefinition?.(removeUnsupportedAgentSettings(parsed));
      if (draftStorageKey) {
        window.sessionStorage.removeItem(draftStorageKey);
      }
    } catch (error) {
      setDraftError(`保存新版本失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  function updateDraft(mutator: (definition: WorkflowDefinitionSummary) => WorkflowDefinitionSummary) {
    const definition = parseWorkflowDraft(draft);
    if (!definition) {
      setDraftError("工作流定义不是有效 JSON，无法进行图形编辑。");
      return;
    }
    updateStoredDraft(JSON.stringify(mutator(definition), null, 2));
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

  function updateNode(nodeId: string, update: (node: WorkflowDefinitionSummary["nodes"][number]) => WorkflowDefinitionSummary["nodes"][number]) {
    updateDraft((definition) => ({
      ...definition,
      nodes: definition.nodes.map((node) => node.id === nodeId ? update(node) : node),
    }));
  }

  function changeNodeKind(nodeId: string, kind: string) {
    updateNode(nodeId, (node) => (
      kind === "agent" ? { ...node, kind } : { ...node, kind, agent: undefined }
    ));
  }

  function addArtifactOutput(nodeId: string) {
    updateNode(nodeId, (node) => ({
      ...node,
      artifacts: {
        outputs: [
          ...(node.artifacts?.outputs ?? []),
          {
            id: `artifact-${(node.artifacts?.outputs.length ?? 0) + 1}`,
            name: "新交付物",
            type: "document",
            required: true,
            path: `docs/runs/{{runId}}/{{nodeId}}/artifact-${(node.artifacts?.outputs.length ?? 0) + 1}.md`,
          },
        ],
      },
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
                  <div className="gate-record" role="listitem" key={node.id}>
                    <div className="panel-heading">
                      <strong><span>{node.name}</span> · {node.id} · {node.kind}</strong>
                      <button className="quiet-button" aria-label={`删除节点 ${node.id}`} onClick={() => removeNode(node.id)}>删除</button>
                    </div>
                    <div className="form-grid">
                      <label>
                        推进方式
                        <select
                          aria-label={`${node.id} 推进方式`}
                          value={node.advance?.mode ?? "manual"}
                          onChange={(event) => updateNode(node.id, (current) => ({
                            ...current, advance: { mode: event.target.value as "manual" | "auto" },
                          }))}
                        >
                          <option value="manual">人工完成</option>
                          <option value="auto">自动推进</option>
                        </select>
                      </label>
                      <label>
                        节点类型
                        <select
                          aria-label={`${node.id} 节点类型`}
                          value={node.kind}
                          onChange={(event) => changeNodeKind(node.id, event.target.value)}
                        >
                          {NODE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>{kind}</option>
                          ))}
                        </select>
                      </label>
                      {node.kind === "agent" ? (
                        <>
                      <label className="form-wide">
                        Agent 节点模板
                        <textarea
                          aria-label={`${node.id} Agent 节点模板`}
                          value={node.agent?.promptTemplate ?? ""}
                          onChange={(event) => updateNode(node.id, (current) => ({
                            ...current,
                            agent: {
                              promptTemplate: event.target.value,
                              context: current.agent?.context ?? { upstream: "none", maxArtifacts: 8, summaryCharsPerArtifact: 2000, maxTotalChars: 8000 },
                            },
                          }))}
                        />
                      </label>
                      <label>
                        允许的产物类型（逗号分隔）
                        <input
                          aria-label={`${node.id} 允许的产物类型`}
                          value={(node.agent?.context?.artifactTypes ?? []).join(", ")}
                          onChange={(event) => updateNode(node.id, (current) => ({
                            ...current,
                            agent: {
                              promptTemplate: current.agent?.promptTemplate,
                              context: {
                                ...(current.agent?.context ?? { upstream: "none", maxArtifacts: 8, summaryCharsPerArtifact: 2000, maxTotalChars: 8000 }),
                                artifactTypes: event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                              },
                            },
                          }))}
                        />
                      </label>
                      <label>
                        最多引用产物
                        <input type="number" min="1" aria-label={`${node.id} 最多引用产物`} value={node.agent?.context?.maxArtifacts ?? 8} onChange={(event) => updateNode(node.id, (current) => ({ ...current, agent: { promptTemplate: current.agent?.promptTemplate, context: { ...(current.agent?.context ?? { upstream: "none", summaryCharsPerArtifact: 2000, maxTotalChars: 8000 }), maxArtifacts: Math.max(1, Number(event.target.value) || 1) } } }))} />
                      </label>
                      <label>
                        单产物摘要上限
                        <input type="number" min="1" aria-label={`${node.id} 单产物摘要上限`} value={node.agent?.context?.summaryCharsPerArtifact ?? 2000} onChange={(event) => updateNode(node.id, (current) => ({ ...current, agent: { promptTemplate: current.agent?.promptTemplate, context: { ...(current.agent?.context ?? { upstream: "none", maxArtifacts: 8, maxTotalChars: 8000 }), summaryCharsPerArtifact: Math.max(1, Number(event.target.value) || 1) } } }))} />
                      </label>
                      <label>
                        上下文总长度上限
                        <input type="number" min="1" aria-label={`${node.id} 上下文总长度上限`} value={node.agent?.context?.maxTotalChars ?? 8000} onChange={(event) => updateNode(node.id, (current) => ({ ...current, agent: { promptTemplate: current.agent?.promptTemplate, context: { ...(current.agent?.context ?? { upstream: "none", maxArtifacts: 8, summaryCharsPerArtifact: 2000 }), maxTotalChars: Math.max(1, Number(event.target.value) || 1) } } }))} />
                      </label>
                      <label>
                        上游上下文范围
                        <select
                          aria-label={`${node.id} 上游上下文范围`}
                          value={node.agent?.context?.upstream ?? "none"}
                          onChange={(event) => updateNode(node.id, (current) => ({
                            ...current,
                            agent: {
                              promptTemplate: current.agent?.promptTemplate,
                              context: { ...(current.agent?.context ?? { maxArtifacts: 8, summaryCharsPerArtifact: 2000, maxTotalChars: 8000 }), upstream: event.target.value as "none" | "direct" | "ancestors" },
                            },
                          }))}
                        >
                          <option value="none">不注入</option>
                          <option value="direct">直接上游</option>
                          <option value="ancestors">全部上游</option>
                        </select>
                      </label>
                        </>
                      ) : null}
                    </div>
                    <div className="panel-heading"><strong>交付物规范</strong><button className="quiet-button" onClick={() => addArtifactOutput(node.id)}>新增交付物</button></div>
                    {(node.artifacts?.outputs ?? []).map((output, index) => (
                      <div className="form-grid" key={`${node.id}-${output.id}-${index}`}>
                        <label>规范 ID<input aria-label={`${node.id} 交付物 ${index + 1} 规范 ID`} value={output.id} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) } }))} /></label>
                        <label>名称<input aria-label={`${node.id} 交付物 ${index + 1} 名称`} value={output.name} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) } }))} /></label>
                        <label>类型<input aria-label={`${node.id} 交付物 ${index + 1} 类型`} value={output.type} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item) } }))} /></label>
                        <label className="form-wide">项目内路径<input aria-label={`${node.id} 交付物 ${index + 1} 路径`} value={output.path} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item) } }))} /></label>
                        <label>模板路径<input aria-label={`${node.id} 交付物 ${index + 1} 模板路径`} value={output.templatePath ?? ""} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, templatePath: event.target.value || undefined } : item) } }))} /></label>
                        <label className="form-wide">交付物说明<textarea aria-label={`${node.id} 交付物 ${index + 1} 说明`} value={output.description ?? ""} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value || undefined } : item) } }))} /></label>
                        <label><input type="checkbox" checked={output.required} onChange={(event) => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) } }))} /> 必需交付物</label>
                        <button className="quiet-button" aria-label={`删除 ${node.id} 交付物 ${index + 1}`} onClick={() => updateNode(node.id, (current) => ({ ...current, artifacts: { outputs: (current.artifacts?.outputs ?? []).filter((_, itemIndex) => itemIndex !== index) } }))}>删除交付物</button>
                      </div>
                    ))}
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
                onChange={(event) => updateStoredDraft(event.target.value)}
                rows={18}
                spellCheck={false}
              />
            </label>
            <label>
              比较版本
              <select
                value={selectedHistoryVersionId}
                onChange={(event) => {
                  const selectedVersionId = event.target.value;
                  setSelectedHistoryVersionId(selectedVersionId);
                  if (selectedVersionId) {
                    onCompareVersion?.(selectedVersionId);
                  }
                }}
                disabled={history.length === 0 || !onCompareVersion}
              >
                <option value="">选择版本</option>
                {history.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.version} · {version.nodeCount ?? "?"} 个节点 · {version.edgeCount ?? "?"} 条连线 · {version.createdAt}
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
          {selectedHistoryVersion ? (
            <p className="body-copy">
              选中版本内容：{selectedHistoryVersion.nodeSummary ?? "未提供节点摘要"}。
              {selectedHistoryVersion.nodeCount === 0 ? "警告：该版本没有任何节点，恢复后可视化编辑器将为空。" : ""}
            </p>
          ) : null}
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
              disabled={!selectedHistoryVersionId || !onRestoreVersion}
              onClick={() => {
                if (selectedHistoryVersion?.nodeCount === 0 && !window.confirm("该历史版本没有节点，确定要恢复吗？")) {
                  return;
                }
                onRestoreVersion?.(selectedHistoryVersionId);
              }}
            >
              恢复为新版本
            </button>
            <button
              className="quiet-button"
              onClick={() => {
                if (draftStorageKey) {
                  window.sessionStorage.removeItem(draftStorageKey);
                }
                setDraft(JSON.stringify(workflow, null, 2));
              }}
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

function removeUnsupportedAgentSettings(definition: WorkflowDefinitionSummary): WorkflowDefinitionSummary {
  return {
    ...definition,
    nodes: definition.nodes.map(({ agent, ...node }) => (
      node.kind === "agent" ? { ...node, agent } : node
    )),
  };
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
