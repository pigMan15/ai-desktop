import type { RunProjection } from "@workflow-platform/contracts";

import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";

type WorkflowNode = WorkflowDefinitionSummary["nodes"][number];
type WorkflowEdgeWithCondition = WorkflowDefinitionSummary["edges"][number] & {
  condition?: string;
};
type AllowedAction = RunProjection["allowedActions"][number];
type RunEventType = AllowedAction["eventType"];

export type RunProgressStatus = "current" | "completed" | "blocked" | "failed" | "pending" | "skipped";
export type RunProgressEdgeStatus = "completed" | "current" | "blocked" | "failed" | "pending";

export type RunProgressNode = {
  id: string;
  name: string;
  kind: WorkflowNode["kind"];
  description?: string;
  role?: string;
  state: RunProjection["nodeStates"][string];
  status: RunProgressStatus;
  current: boolean;
  successors: string[];
  workflowNode: WorkflowNode;
};

export type RunProgressEdge = {
  id: string;
  source: string;
  target: string;
  status: RunProgressEdgeStatus;
  active: boolean;
};

export type RunProgressGraph = {
  nodes: RunProgressNode[];
  edges: RunProgressEdge[];
};

export type RunSuccessorPresentation = {
  kind: "none" | "single" | "multiple";
  items: Array<{
    node: WorkflowNode;
    condition: string | null;
  }>;
};

export type RequiredInputKind = "none" | "artifact" | "gate-evidence" | "waiver-reason";

export type RunGuidanceAction = {
  id: string;
  eventType: RunEventType;
  nodeId?: string;
  risk: AllowedAction["risk"];
  label: string;
  result: string;
  priority: "primary" | "secondary";
  requiredInput: RequiredInputKind;
  allowedAction: AllowedAction;
};

export type RunGuidance = {
  node: RunProgressNode | null;
  runStatus: RunProjection["status"];
  readOnly: boolean;
  actions: RunGuidanceAction[];
  primaryAction: RunGuidanceAction | null;
  secondaryActions: RunGuidanceAction[];
  blockingReason: RunProjection["blockingReasons"][number] | null;
  waitingMessage: string | null;
};

type ActionPresentation = Pick<RunGuidanceAction, "label" | "result" | "priority" | "requiredInput"> & {
  selectionRank: number;
};

type ResolveNodeGuidanceInput = {
  workflow: WorkflowDefinitionSummary;
  projection: RunProjection;
  nodeId: string | null;
  projectArchived: boolean;
};

const ARCHIVED_PROJECT_MESSAGE =
  "项目已归档，运行仅可查看；重新导入项目后可恢复操作。";

const ACTION_PRESENTATION: Record<RunEventType, ActionPresentation> = {
  RUN_CREATED: action("创建运行", "创建新的运行。", "secondary", "none", 100),
  NODE_STARTED: action("启动当前节点", "启动当前节点的工作。", "primary", "none", 800),
  ARTIFACT_SUBMITTED: action("扫描并提交所需产物", "扫描并提交产物，由运行时服务验证。", "primary", "artifact", 1000),
  ARTIFACT_INVALIDATED: action("作废产物", "将产物标记为无效。", "secondary", "none", 200),
  APPROVAL_REQUESTED: action("请求审批", "请求所需的人工审批。", "primary", "none", 450),
  HUMAN_APPROVED: action("批准当前节点", "批准当前节点并继续运行。", "primary", "none", 850),
  HUMAN_REJECTED: action("驳回当前节点", "驳回当前节点并退回修改。", "secondary", "none", 300),
  HUMAN_DEFERRED: action("暂缓决策", "保持运行等待后续决策。", "secondary", "none", 250),
  GATE_STARTED: action("启动检查关卡", "开始评估检查关卡。", "primary", "none", 750),
  GATE_PASSED: action("通过检查关卡", "记录检查关卡通过所需的证据。", "primary", "gate-evidence", 900),
  GATE_FAILED: action("标记检查关卡失败", "记录检查关卡失败所需的证据。", "secondary", "gate-evidence", 350),
  GATE_WAIVED: action("豁免检查关卡", "记录豁免检查关卡的批准理由。", "secondary", "waiver-reason", 325),
  NODE_COMPLETED: action("完成当前节点", "完成当前节点并推进运行。", "primary", "none", 600),
  NODE_FAILED: action("标记当前节点失败", "将当前节点标记为失败。", "secondary", "none", 275),
  NODE_RETRIED: action("重试当前节点", "重试当前节点。", "primary", "none", 700),
  RUN_BLOCKED: action("阻塞运行", "阻止运行继续执行。", "secondary", "none", 150),
  RUN_PAUSED: action("暂停运行", "暂停运行，直到恢复执行。", "secondary", "none", 125),
  RUN_RESUMED: action("恢复运行", "恢复运行执行。", "primary", "none", 500),
  RUN_COMPLETED: action("完成运行", "将运行标记为完成。", "primary", "none", 400),
  RUN_ARCHIVED: action("归档运行", "归档运行以便只读查看。", "secondary", "none", 50),
};

export function buildRunProgressGraph(
  workflow: WorkflowDefinitionSummary,
  projection: RunProjection,
): RunProgressGraph {
  const currentNodeIds = new Set(projection.currentNodeIds);
  const successorsByNodeId = new Map<string, string[]>();

  for (const edge of workflow.edges) {
    const successors = successorsByNodeId.get(edge.from) ?? [];
    successors.push(edge.to);
    successorsByNodeId.set(edge.from, successors);
  }

  return {
    nodes: workflow.nodes.map((node) => toProgressNode(node, projection, currentNodeIds, successorsByNodeId)),
    edges: workflow.edges.map((edge) => {
      const status = progressEdgeStatus(edge.from, edge.to, projection, currentNodeIds);
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        status,
        active: status === "current",
      };
    }),
  };
}

export function resolveRunSuccessors(
  workflow: WorkflowDefinitionSummary,
  nodeId: string,
): RunSuccessorPresentation {
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const items = workflow.edges
    .filter((edge) => edge.from === nodeId)
    .map((edge) => {
      const conditionedEdge = edge as WorkflowEdgeWithCondition;
      const node = nodesById.get(edge.to);
      return node
        ? { node, condition: conditionedEdge.condition?.trim() || null }
        : null;
    })
    .filter((item): item is RunSuccessorPresentation["items"][number] => item !== null);

  return {
    kind: items.length === 0 ? "none" : items.length === 1 ? "single" : "multiple",
    items,
  };
}

export function resolveNodeGuidance({
  workflow,
  projection,
  nodeId,
  projectArchived,
}: ResolveNodeGuidanceInput): RunGuidance {
  const graph = buildRunProgressGraph(workflow, projection);
  const node = graph.nodes.find((candidate) => candidate.id === nodeId) ?? null;
  const blockingReason = projection.blockingReasons[0] ?? null;

  if (projectArchived) {
    return {
      node,
      runStatus: projection.status,
      readOnly: true,
      actions: [],
      primaryAction: null,
      secondaryActions: [],
      blockingReason,
      waitingMessage: ARCHIVED_PROJECT_MESSAGE,
    };
  }

  const actions = projection.allowedActions
    .filter((candidate) => candidate.nodeId === nodeId || candidate.nodeId === undefined)
    .map(toGuidanceAction);
  const primaryAction = [...actions].sort(compareActionPriority)[0] ?? null;
  const secondaryActions = actions.filter((candidate) => candidate !== primaryAction);

  return {
    node,
    runStatus: projection.status,
    readOnly: false,
    actions,
    primaryAction,
    secondaryActions,
    blockingReason,
    waitingMessage: primaryAction ? null : blockingReason?.message ?? null,
  };
}

export function resolveAllowedActionGuidance(
  projection: RunProjection,
): RunGuidanceAction[] {
  return projection.allowedActions.map(toGuidanceAction);
}

function action(
  label: string,
  result: string,
  priority: RunGuidanceAction["priority"],
  requiredInput: RequiredInputKind,
  selectionRank: number,
): ActionPresentation {
  return { label, result, priority, requiredInput, selectionRank };
}

function toProgressNode(
  node: WorkflowNode,
  projection: RunProjection,
  currentNodeIds: Set<string>,
  successorsByNodeId: Map<string, string[]>,
): RunProgressNode {
  const current = currentNodeIds.has(node.id);
  const state = projection.nodeStates[node.id] ?? "PENDING";

  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    description: node.description,
    role: node.role,
    state,
    status: current ? "current" : progressStatus(state),
    current,
    successors: successorsByNodeId.get(node.id) ?? [],
    workflowNode: node,
  };
}

function toGuidanceAction(allowedAction: AllowedAction): RunGuidanceAction {
  const { selectionRank: _selectionRank, ...presentation } = ACTION_PRESENTATION[allowedAction.eventType];

  return {
    ...presentation,
    id: allowedAction.id,
    eventType: allowedAction.eventType,
    nodeId: allowedAction.nodeId,
    risk: allowedAction.risk,
    allowedAction,
  };
}

function compareActionPriority(left: RunGuidanceAction, right: RunGuidanceAction): number {
  const rankDifference =
    ACTION_PRESENTATION[right.eventType].selectionRank - ACTION_PRESENTATION[left.eventType].selectionRank;
  if (rankDifference !== 0) return rankDifference;

  const eventDifference = left.eventType.localeCompare(right.eventType);
  return eventDifference !== 0 ? eventDifference : left.id.localeCompare(right.id);
}

function progressEdgeStatus(
  source: string,
  target: string,
  projection: RunProjection,
  currentNodeIds: Set<string>,
): RunProgressEdgeStatus {
  const sourceState = projection.nodeStates[source] ?? "PENDING";
  const targetState = projection.nodeStates[target] ?? "PENDING";

  if (sourceState === "FAILED" || targetState === "FAILED") return "failed";
  if (sourceState === "BLOCKED" || targetState === "BLOCKED") return "blocked";
  if (sourceState === "PASSED" || targetState === "PASSED") return "completed";
  if (
    currentNodeIds.has(source) &&
    (currentNodeIds.has(target) || targetState === "READY")
  ) {
    return "current";
  }
  return "pending";
}

function progressStatus(state: RunProgressNode["state"]): RunProgressStatus {
  if (state === "PASSED") return "completed";
  if (state === "BLOCKED") return "blocked";
  if (state === "FAILED") return "failed";
  if (state === "SKIPPED") return "skipped";
  return "pending";
}
