import { useEffect, useState } from "react";

import type {
  CompiledWorkflowSummary,
  RuntimeWorkbenchState,
  WorkflowDefinitionSummary,
  WorkflowExportFormat,
  WorkflowSimulation,
  WorkflowVersionDiff,
  WorkflowVersionSummary,
  RoleAssetSummary,
} from "../../app/runtimeClient";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { RoleLibrary } from "./RoleLibrary";
import { applyNodePositions, autoLayoutPositions } from "./workflowCanvasModel";

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
  onBack?: () => void;
  roleAssets?: RoleAssetSummary[];
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
  onBack,
  roleAssets = [],
}: Props) {
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [newNodeId, setNewNodeId] = useState("");
  const [newNodeName, setNewNodeName] = useState("");
  const [newNodeKind, setNewNodeKind] = useState("task");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedHistoryVersionId, setSelectedHistoryVersionId] = useState("");
  const [exportFormat, setExportFormat] = useState<WorkflowExportFormat>("canonical-json");
  const [canvasViewResetKey, setCanvasViewResetKey] = useState(0);
  const [activeCanvasPanel, setActiveCanvasPanel] = useState<"nodes" | "roles" | "workflow" | "simulation" | null>(null);
  const editableWorkflow = parseWorkflowDraft(draft);
  const draftStorageKey = workflowVersionId ? `workflow-draft:${workflowVersionId}` : null;
  const selectedHistoryVersion = history.find((version) => version.id === selectedHistoryVersionId);
  const selectedNode = editableWorkflow?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const activeRoleAssets = roleAssets.filter((role) => !role.archivedAt);

  useEffect(() => {
    const storedDraft = draftStorageKey ? window.sessionStorage.getItem(draftStorageKey) : null;
    setDraft(storedDraft ?? (workflow ? JSON.stringify(workflow, null, 2) : ""));
    setDraftError(null);
    setSelectedHistoryVersionId("");
    setSelectedNodeId(null);
  }, [draftStorageKey, workflow]);

  useEffect(() => {
    if (simulation) {
      setActiveCanvasPanel("simulation");
    }
  }, [simulation]);

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
      const definition = removeUnsupportedAgentSettings(parsed);
      await onSaveDefinition?.(
        roleAssets.length > 0 ? normalizeGlobalRoleBindings(definition, activeRoleAssets) : definition,
      );
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
    setCanvasViewResetKey((current) => current + 1);
    setSelectedNodeId(id);
    setNewNodeId("");
    setNewNodeName("");
    setNewNodeKind("task");
  }

  function organizeCanvas() {
    updateDraft((definition) => applyNodePositions(
      definition,
      autoLayoutPositions(definition.nodes, definition.edges),
    ));
    setCanvasViewResetKey((current) => current + 1);
  }

  function removeNode(nodeId: string) {
    updateDraft((definition) => ({
      ...definition,
      nodes: definition.nodes.filter((node) => node.id !== nodeId),
      edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
  }

  function removeNodes(nodeIds: string[]) {
    const removedIds = new Set(nodeIds);
    if (removedIds.size === 0) return;
    updateDraft((definition) => ({
      ...definition,
      nodes: definition.nodes.filter((node) => !removedIds.has(node.id)),
      edges: definition.edges.filter((edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to)),
    }));
    if (selectedNodeId && removedIds.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }

  function updateNode(nodeId: string, update: (node: WorkflowDefinitionSummary["nodes"][number]) => WorkflowDefinitionSummary["nodes"][number]) {
    updateDraft((definition) => ({
      ...definition,
      nodes: definition.nodes.map((node) => node.id === nodeId ? update(node) : node),
    }));
  }

  function bindNodeToGlobalRole(nodeId: string, roleId: string) {
    const selectedRole = activeRoleAssets.find((role) => role.id === roleId);
    updateDraft((definition) => ({
      ...definition,
      roles: selectedRole
        ? [...definition.roles.filter((role) => role.id !== selectedRole.id), toRoleSnapshot(selectedRole)]
        : definition.roles,
      nodes: definition.nodes.map((node) => node.id === nodeId ? {
        ...node,
        agent: {
          ...node.agent,
          roleId: selectedRole?.id || undefined,
          context: node.agent?.context ?? { upstream: "none", maxArtifacts: 8, summaryCharsPerArtifact: 2000, maxTotalChars: 8000 },
        },
      } : node),
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

  const simulationPanel = simulation && activeCanvasPanel === "simulation" ? (
    <aside id="workflow-simulation" className="workflow-simulation" aria-label="模拟结果">
      <div className="workflow-floating-panel-heading">
        <div>
          <strong>模拟结果</strong>
          <span className="status-pill">{simulation.status === "ready" ? "可运行" : "存在阻塞"}</span>
        </div>
        <button type="button" className="quiet-button" aria-label="关闭模拟结果" onClick={() => setActiveCanvasPanel(null)}>关闭</button>
      </div>
      <ul className="compact-list" aria-label="工作流模拟步骤">
        {simulation.steps.map((step) => <li key={step.nodeId}>{step.nodeId}：{step.state}</li>)}
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
    </aside>
  ) : null;

  const workflowConfigurationPanel = (
    <aside id="workflow-configuration" className="workflow-configuration" aria-label="工作流配置" hidden={activeCanvasPanel !== "workflow"}>
      <div className="workflow-floating-panel-heading">
        <strong>工作流配置</strong>
        <button type="button" className="quiet-button" aria-label="关闭工作流配置" onClick={() => setActiveCanvasPanel(null)}>关闭</button>
      </div>
      <div className="form-grid">
        <label className="form-wide">
          工作流定义 JSON
          <textarea value={draft} onChange={(event) => updateStoredDraft(event.target.value)} rows={18} spellCheck={false} />
        </label>
        <label>
          比较版本
          <select
            value={selectedHistoryVersionId}
            onChange={(event) => {
              const selectedVersionId = event.target.value;
              setSelectedHistoryVersionId(selectedVersionId);
              if (selectedVersionId) onCompareVersion?.(selectedVersionId);
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
          <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as WorkflowExportFormat)} disabled={!onExportWorkflow}>
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
        <button className="quiet-button" onClick={() => {
          if (draftStorageKey) window.sessionStorage.removeItem(draftStorageKey);
          setDraft(JSON.stringify(workflow, null, 2));
        }}>重置草稿</button>
      </div>
      {draftError ? <p className="body-copy">{draftError}</p> : null}
    </aside>
  );

  return (
    <section id="workflow" className="panel page-workspace page-workflow" aria-labelledby="workflow-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">工作流</p>
          <h2 id="workflow-title">工作流视图</h2>
        </div>
        {onBack ? <button type="button" className="quiet-button" onClick={onBack}>返回列表</button> : null}
      </div>
      {!workflow ? <p className="body-copy">正在加载工作流定义...</p> : null}
      {workflow ? (
        <>
          <div className="panel-heading">
            <div>
              <strong>{workflow.name}</strong>
              <span className="status-pill">版本 {workflow.version}</span>
            </div>
            <div className="workflow-editor-actions">
              <span className="status-pill">{editableWorkflow ? "草稿可编辑" : "JSON 有错误"}</span>
              <button type="button" className="quiet-button" disabled={!onSimulate} onClick={onSimulate}>模拟版本</button>
              <button
                type="button"
                className="quiet-button"
                aria-label="工作流配置"
                aria-expanded={activeCanvasPanel === "workflow"}
                aria-controls="workflow-configuration"
                onClick={() => setActiveCanvasPanel((panel) => panel === "workflow" ? null : "workflow")}
              >
                版本管理
              </button>
              <button type="button" className="quiet-button" disabled={!selectedHistoryVersionId || !onRestoreVersion} onClick={() => onRestoreVersion?.(selectedHistoryVersionId)}>恢复为新版本</button>
              <button type="button" disabled={!draft.trim() || !onSaveDefinition} onClick={saveDraft}>保存新版本</button>
              <button type="button" className="quiet-button" disabled={!onExportWorkflow} onClick={() => onExportWorkflow?.(exportFormat)}>导出工作流</button>
            </div>
          </div>
          {editableWorkflow ? (
            <label className="workflow-name-editor">工作流名称
              <input aria-label="工作流名称" value={editableWorkflow.name} onChange={(event) => updateDraft((definition) => ({ ...definition, name: event.target.value }))} placeholder="请输入工作流名称" />
            </label>
          ) : null}
          <div className="table-like workflow-definition-summary" role="table" aria-label="工作流定义节点">
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
          {editableWorkflow ? (
            <>
              <div className="workflow-editor">
                <div className="workflow-canvas-shell">
                  <div className="workflow-canvas-toolbar" aria-label="画布工具栏">
                    <button
                      type="button"
                      className="quiet-button"
                      aria-expanded={activeCanvasPanel === "nodes"}
                      aria-controls="workflow-node-library"
                      onClick={() => setActiveCanvasPanel((panel) => panel === "nodes" ? null : "nodes")}
                    >
                      节点库
                    </button>
                    <button
                      type="button"
                      className="quiet-button"
                      aria-expanded={activeCanvasPanel === "roles"}
                      aria-controls="workflow-role-library"
                      onClick={() => setActiveCanvasPanel((panel) => panel === "roles" ? null : "roles")}
                    >
                      角色库
                    </button>
                    <button type="button" className="quiet-button" onClick={organizeCanvas}>整理布局</button>
                  </div>
                {activeCanvasPanel === "nodes" ? (
                <aside id="workflow-node-library" className="workflow-toolbox" aria-label="节点工具箱">
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
                        {NODE_TYPE_OPTIONS.map(({ kind, label }) => <option key={kind} value={kind}>{label} ({kind})</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="button-row">
                    <button className="quiet-button" onClick={addNode}>新增节点</button>
                  </div>
                </aside>
                ) : null}
                <WorkflowCanvas
                  definition={editableWorkflow}
                  compiled={compiled}
                  onDefinitionChange={(definition: WorkflowDefinitionSummary) => updateDraft(() => definition)}
                  onRemoveNodes={removeNodes}
                  onSelectNode={setSelectedNodeId}
                  viewResetKey={canvasViewResetKey}
                />
                {activeCanvasPanel === "roles" ? (
                  <div id="workflow-role-library" className="workflow-role-library">
                    <RoleLibrary
                      roles={editableWorkflow.roles}
                      nodes={editableWorkflow.nodes}
                      onChange={(roles) => updateDraft((definition) => ({ ...definition, roles }))}
                      onError={setDraftError}
                      publicRoles={roleAssets}
                    />
                  </div>
                ) : null}
                {workflowConfigurationPanel}
                {simulationPanel}
                </div>
                {selectedNode ? (
                <div className="workflow-inspector-slot">
                  <aside className="workflow-inspector" aria-label="节点属性">
                  <div className="workflow-inspector-content">
                    {(() => {
                      const node = selectedNode;
                      return (
                    <>
                      <div className="panel-heading">
                      <strong><span>{node.name}</span> · {node.id} · {node.kind}</strong>
                      <button
                        type="button"
                        className="quiet-button"
                        aria-label="关闭节点属性"
                        onClick={() => setSelectedNodeId(null)}
                      >
                        关闭
                      </button>
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
                          {NODE_TYPE_OPTIONS.map(({ kind, label }) => (
                            <option key={kind} value={kind}>{label} ({kind})</option>
                          ))}
                        </select>
                      </label>
                      <p className="workflow-node-type-help" role="status">
                        {NODE_TYPE_HELP[node.kind]}
                      </p>
                      {node.kind === "agent" ? (
                        <>
                      <label>
                        执行角色
                        <select
                          aria-label={`节点 ${node.id} 的执行角色`}
                          value={activeRoleAssets.some((role) => role.id === node.agent?.roleId) ? node.agent?.roleId : ""}
                          onChange={(event) => bindNodeToGlobalRole(node.id, event.target.value)}
                        >
                          <option value="">未绑定执行角色</option>
                          {activeRoleAssets.map((role) => (
                            <option key={role.id} value={role.id}>{role.name}</option>
                          ))}
                        </select>
                      </label>
                      {node.agent?.roleId && !activeRoleAssets.some((role) => role.id === node.agent?.roleId) ? (
                        <p className="workflow-node-type-help" role="alert">原角色已不存在或已归档，请重新绑定角色库中的角色。</p>
                      ) : null}
                      <label className="form-wide">
                        Agent 节点模板
                        <textarea
                          aria-label={`${node.id} Agent 节点模板`}
                          value={node.agent?.promptTemplate ?? ""}
                          onChange={(event) => updateNode(node.id, (current) => ({
                            ...current,
                            agent: {
                              ...current.agent,
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
                              ...current.agent,
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
                        <input type="number" min="1" aria-label={`${node.id} 最多引用产物`} value={node.agent?.context?.maxArtifacts ?? 8} onChange={(event) => updateNode(node.id, (current) => ({ ...current, agent: { ...current.agent, promptTemplate: current.agent?.promptTemplate, context: { ...(current.agent?.context ?? { upstream: "none", summaryCharsPerArtifact: 2000, maxTotalChars: 8000 }), maxArtifacts: Math.max(1, Number(event.target.value) || 1) } } }))} />
                      </label>
                      <label>
                        单产物摘要上限
                        <input type="number" min="1" aria-label={`${node.id} 单产物摘要上限`} value={node.agent?.context?.summaryCharsPerArtifact ?? 2000} onChange={(event) => updateNode(node.id, (current) => ({ ...current, agent: { ...current.agent, promptTemplate: current.agent?.promptTemplate, context: { ...(current.agent?.context ?? { upstream: "none", maxArtifacts: 8, maxTotalChars: 8000 }), summaryCharsPerArtifact: Math.max(1, Number(event.target.value) || 1) } } }))} />
                      </label>
                      <label>
                        上下文总长度上限
                        <input type="number" min="1" aria-label={`${node.id} 上下文总长度上限`} value={node.agent?.context?.maxTotalChars ?? 8000} onChange={(event) => updateNode(node.id, (current) => ({ ...current, agent: { ...current.agent, promptTemplate: current.agent?.promptTemplate, context: { ...(current.agent?.context ?? { upstream: "none", maxArtifacts: 8, summaryCharsPerArtifact: 2000 }), maxTotalChars: Math.max(1, Number(event.target.value) || 1) } } }))} />
                      </label>
                      <label>
                        上游上下文范围
                        <select
                          aria-label={`${node.id} 上游上下文范围`}
                          value={node.agent?.context?.upstream ?? "none"}
                          onChange={(event) => updateNode(node.id, (current) => ({
                            ...current,
                            agent: {
                              ...current.agent,
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
                      <div className="form-grid" key={`${node.id}-artifact-output-${index}`}>
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
                    </>
                      );
                    })()}
                  </div>
                  </aside>
                </div>
                ) : null}
              </div>
            </>
          ) : null}
          {!editableWorkflow ? (
          <>
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

function toRoleSnapshot(role: RoleAssetSummary) {
  return { ...role, assetVersionId: role.roleVersionId };
}

function normalizeGlobalRoleBindings(
  definition: WorkflowDefinitionSummary,
  activeRoleAssets: RoleAssetSummary[],
): WorkflowDefinitionSummary {
  const activeRolesById = new Map(activeRoleAssets.map((role) => [role.id, role]));
  const nodes = definition.nodes.map((node) => {
    if (node.kind !== "agent" || !node.agent?.roleId || activeRolesById.has(node.agent.roleId)) {
      return node;
    }
    return { ...node, agent: { ...node.agent, roleId: undefined } };
  });
  const referencedRoleIds = new Set(nodes.flatMap((node) => node.agent?.roleId ? [node.agent.roleId] : []));

  return {
    ...definition,
    nodes,
    roles: activeRoleAssets
      .filter((role) => referencedRoleIds.has(role.id))
      .map(toRoleSnapshot),
  };
}

const NODE_TYPE_OPTIONS = [
  { kind: "task", label: "人工任务" },
  { kind: "agent", label: "Agent 执行" },
  { kind: "approval", label: "人工审批" },
  { kind: "gate", label: "质量门禁" },
  { kind: "evidence", label: "证据登记" },
  { kind: "deploy", label: "部署" },
  { kind: "report", label: "报告" },
  { kind: "composite", label: "组合阶段" },
] as const;

const NODE_TYPE_HELP: Record<string, string> = {
  task: "人工任务：由操作者完成工作并在 Run 中手动推进节点。",
  agent: "Agent 执行：可绑定角色并启动 Codex 或 Claude 执行该节点。",
  approval: "人工审批：等待指定人员作出通过、拒绝或延后决定。",
  gate: "质量门禁：依据交付物和验证证据决定是否允许继续。",
  evidence: "证据登记：记录可追溯的文件、日志或验证材料。",
  deploy: "部署：执行受控部署，并保留部署输出与回滚信息。",
  report: "报告：汇总当前阶段结果，形成可交付的报告。",
  composite: "组合阶段：用于组织多个步骤；本身不直接执行命令。",
};
