import { useEffect, useState } from "react";

import type { WorkflowDefinitionSummary, WorkflowRoleSummary } from "../../app/runtimeClient";

type Props = {
  roles: WorkflowRoleSummary[];
  nodes: WorkflowDefinitionSummary["nodes"];
  onChange: (roles: WorkflowRoleSummary[]) => void;
  onError: (message: string) => void;
};

const DEVELOPER_TEMPLATE: WorkflowRoleSummary = {
  id: "developer",
  name: "开发",
  purpose: "将批准的方案转化为可验证的实现。",
  description: "负责在明确范围内完成代码或配置变更。",
  instructions: "遵循已批准的计划，实施改动并验证结果。",
  inputRequirements: "读取上游计划、约束和相关代码。",
  outputRequirements: "提交可审查的改动，并说明验证结果。",
  acceptanceCriteria: "测试通过，变更范围与批准目标一致。",
  forbiddenActions: "不得绕过审批，不得修改未授权范围。",
  provider: "codex",
  allowedTools: ["read", "edit", "test"],
};

const HARNESS_REFERENCE_ROLES: WorkflowRoleSummary[] = [
  { id: "deployer", name: "部署", purpose: "在授权且安全的前提下执行预发或生产部署。", instructions: "确认目标环境、回滚路径和部署授权；记录部署证据后交由测试角色检查。", outputRequirements: "部署记录与证据。", forbiddenActions: "生产部署未获用户明确确认时不得执行。", provider: "codex", allowedTools: ["read", "edit", "test"] },
  { id: "developer", name: "开发", purpose: "执行已确认的实施计划。", inputRequirements: "已确认的编码设计和实施计划。", instructions: "优先小改动并遵循现有模式；行为变化时更新测试；完成后交由验证角色复核。", outputRequirements: "实现记录、变更文件和测试说明。", forbiddenActions: "不得标记验证门禁通过、不得部署、不得未授权扩大范围。", provider: "codex", allowedTools: ["read", "edit", "test"] },
  { id: "dispatcher", name: "流程调度", purpose: "依据工作流状态选择下一流程步骤。", inputRequirements: "当前工作流状态、意图、风险和阶段产物。", instructions: "选择首个未完成的必需节点，更新当前节点与下一角色；门禁失败时遵循失败恢复策略和重试上限。", outputRequirements: "包含意图、风险、下一节点、角色和原因的调度决策。", forbiddenActions: "不得编辑源码、运行构建或测试、合成评审结果或自行标记门禁通过。", provider: "codex", allowedTools: ["read"] },
  { id: "intent-classifier", name: "意图分类", purpose: "将用户请求归类为意图和风险。", instructions: "给出 QUERY、BUG_FIX、FEATURE、REFACTOR、DEPLOYMENT 或 INCIDENT，以及 NA、LOW、MEDIUM、HIGH 风险。", outputRequirements: "包含 intent、risk、reason 和 required_confirmation 的 JSON。", provider: "codex", allowedTools: ["read"] },
  { id: "knowledge-keeper", name: "知识沉淀", purpose: "从已完成 Run 中提炼可复用的增量工程知识。", inputRequirements: "需求上下文、验收证据和阶段产物。", instructions: "只提取已验证的新增知识，判断类型、优先级、领域和置信度，并生成沉淀草稿。", outputRequirements: "知识沉淀草稿和候选知识表。", forbiddenActions: "不得自动写入知识库、沉淀敏感信息、未验证猜测或一次性输出。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "orchestrator", name: "编排", purpose: "合成阶段输出并请求必要的人工决策。", instructions: "合并独立评审并保留分歧，识别未解决决策并路由回调度角色。", forbiddenActions: "不得实现代码、替用户决定业务取舍或修改门禁状态。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "plan-generator", name: "计划", purpose: "把已确认的需求和方案转换为可执行计划。", instructions: "拆分为小而可验证的任务，明确受影响文件，并为每项任务提供验证命令。", outputRequirements: "目标、假设、任务列表、验证和回滚计划。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "quality-guardian", name: "质量预检", purpose: "在实施前挑战方案并识别风险。", instructions: "识别失败模式，使测试范围匹配风险；中高风险必须制定回滚方案和门禁预期。", outputRequirements: "失败模式、测试策略、门禁预期、回滚预期和停止条件。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "requirement-analyst", name: "需求分析", purpose: "澄清目标、范围、约束与验收标准。", instructions: "复述用户目标，定义范围和非目标，列出开放问题、风险和需要决策事项。", outputRequirements: "需求评审，包含目标、范围、非目标、验收标准和开放问题。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "state-keeper", name: "状态维护", purpose: "维护持久化流程状态和阶段记录。", instructions: "流程换阶段时更新状态、产物路径、分支和工作区元数据；保证证据不足时不标记门禁通过。", outputRequirements: "状态更新说明。", forbiddenActions: "不得在没有验证证据时将门禁标记为 PASS。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "tech-architect", name: "技术架构", purpose: "设计技术方案与集成边界。", instructions: "先检查现有架构，选择最小可行设计，明确受影响模块、数据流、兼容性、回滚和被拒绝方案。", outputRequirements: "技术方案。", provider: "codex", allowedTools: ["read", "edit"] },
  { id: "tester", name: "测试", purpose: "在部署后或高风险变更后执行接口、冒烟和验收测试。", instructions: "尽可能将验收标准转为可执行检查，记录确切输入、输出、结果、失败和剩余风险。", outputRequirements: "接口测试报告。", acceptanceCriteria: "所有描述性文字使用中文。", provider: "codex", allowedTools: ["read", "test"] },
  { id: "verifier", name: "验证", purpose: "独立验证实现结果与门禁证据。", instructions: "执行编译、测试和静态检查，检查证据；门禁失败时记录重试并交由调度角色恢复。", outputRequirements: "编译、测试、验收和证据报告。", forbiddenActions: "不得隐藏失败命令、绕过失败恢复；除非重新指定为开发角色，否则不得实现修复。", provider: "codex", allowedTools: ["read", "test"] },
];

export function RoleLibrary({ roles, nodes, onChange, onError }: Props) {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(roles[0]?.id ?? null);
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null;

  useEffect(() => {
    if (!selectedRole && roles[0]) setSelectedRoleId(roles[0].id);
  }, [roles, selectedRole]);

  function addRole(template?: WorkflowRoleSummary) {
    const id = uniqueRoleId(template?.id ?? "new-role", roles);
    const role = { ...template, id, name: template?.name ?? "新角色" };
    onChange([...roles, role]);
    setSelectedRoleId(id);
  }

  function importHarnessRoles() {
    const existingIds = new Set(roles.map((role) => role.id));
    const imported = HARNESS_REFERENCE_ROLES.filter((role) => !existingIds.has(role.id));
    if (imported.length === 0) {
      onError("Harness 参考角色已全部存在于当前工作流。");
      return;
    }
    onChange([...roles, ...imported]);
    setSelectedRoleId(imported[0].id);
  }

  function updateRole(update: (role: WorkflowRoleSummary) => WorkflowRoleSummary) {
    if (!selectedRole) return;
    onChange(roles.map((role) => role.id === selectedRole.id ? update(role) : role));
  }

  function removeRole(roleId: string) {
    const referencingNodes = nodes.filter((node) => node.agent?.roleId === roleId);
    if (referencingNodes.length > 0) {
      onError(`角色仍被节点 ${referencingNodes.map((node) => node.id).join("、")} 使用`);
      return;
    }
    const nextRoles = roles.filter((role) => role.id !== roleId);
    onChange(nextRoles);
    setSelectedRoleId(nextRoles[0]?.id ?? null);
  }

  return (
    <section className="role-library" aria-label="角色库">
      <div className="role-library-header">
        <div>
          <strong>角色库</strong>
          <span>{roles.length} 个角色</span>
        </div>
        <div className="button-row">
          <button type="button" className="quiet-button" onClick={() => addRole()}>新增角色</button>
          <button type="button" className="quiet-button" onClick={() => addRole(DEVELOPER_TEMPLATE)}>开发模板</button>
          <button type="button" className="quiet-button" onClick={importHarnessRoles}>导入 Harness 参考角色</button>
        </div>
      </div>
      <div className="role-library-layout">
        <div className="role-library-list" role="listbox" aria-label="角色列表">
          {roles.length === 0 ? <p className="body-copy">还没有角色，先创建一个角色。</p> : null}
          {roles.map((role) => (
            <button
              type="button"
              role="option"
              aria-selected={role.id === selectedRoleId}
              className="role-library-list-item"
              key={role.id}
              onClick={() => setSelectedRoleId(role.id)}
            >
              <strong>{role.name || role.id}</strong>
              <span>{role.id}{role.disabled ? " · 已禁用" : ""}</span>
            </button>
          ))}
        </div>
        {selectedRole ? (
          <div className="role-library-editor" aria-label={`编辑角色 ${selectedRole.id}`}>
            <div className="role-library-editor-heading">
              <div>
                <strong>{selectedRole.name || selectedRole.id}</strong>
                <span>角色 ID：{selectedRole.id}</span>
              </div>
              <button type="button" className="quiet-button" aria-label={`删除角色 ${selectedRole.id}`} onClick={() => removeRole(selectedRole.id)}>删除角色</button>
            </div>
            <div className="form-grid">
              <label>名称<input aria-label={`角色 ${selectedRole.id} 的名称`} value={selectedRole.name} onChange={(event) => updateRole((role) => ({ ...role, name: event.target.value }))} /></label>
              <label>默认 Provider<select aria-label={`角色 ${selectedRole.id} 的默认 Provider`} value={selectedRole.provider ?? ""} onChange={(event) => updateRole((role) => ({ ...role, provider: event.target.value as WorkflowRoleSummary["provider"] || undefined }))}><option value="">未指定</option><option value="codex">codex</option><option value="claude">claude</option></select></label>
              <label>默认模型<input aria-label={`角色 ${selectedRole.id} 的默认模型`} value={selectedRole.model ?? ""} placeholder="可选" onChange={(event) => updateRole((role) => ({ ...role, model: event.target.value || undefined }))} /></label>
              <label className="form-wide">角色目标<textarea aria-label={`角色 ${selectedRole.id} 的角色目标`} value={selectedRole.purpose ?? ""} onChange={(event) => updateRole((role) => ({ ...role, purpose: event.target.value || undefined }))} /></label>
              <label className="form-wide">简介<textarea aria-label={`角色 ${selectedRole.id} 的简介`} value={selectedRole.description ?? ""} onChange={(event) => updateRole((role) => ({ ...role, description: event.target.value || undefined }))} /></label>
              <label className="form-wide">职责与边界<textarea aria-label={`角色 ${selectedRole.id} 的职责与边界`} value={selectedRole.instructions ?? ""} onChange={(event) => updateRole((role) => ({ ...role, instructions: event.target.value || undefined }))} /></label>
              <label className="form-wide">输入上下文要求<textarea aria-label={`角色 ${selectedRole.id} 的输入上下文要求`} value={selectedRole.inputRequirements ?? ""} onChange={(event) => updateRole((role) => ({ ...role, inputRequirements: event.target.value || undefined }))} /></label>
              <label className="form-wide">输出与交付要求<textarea aria-label={`角色 ${selectedRole.id} 的输出与交付要求`} value={selectedRole.outputRequirements ?? ""} onChange={(event) => updateRole((role) => ({ ...role, outputRequirements: event.target.value || undefined }))} /></label>
              <label className="form-wide">验收标准<textarea aria-label={`角色 ${selectedRole.id} 的验收标准`} value={selectedRole.acceptanceCriteria ?? ""} onChange={(event) => updateRole((role) => ({ ...role, acceptanceCriteria: event.target.value || undefined }))} /></label>
              <label className="form-wide">禁止行为<textarea aria-label={`角色 ${selectedRole.id} 的禁止行为`} value={selectedRole.forbiddenActions ?? ""} onChange={(event) => updateRole((role) => ({ ...role, forbiddenActions: event.target.value || undefined }))} /></label>
              <label className="form-wide">允许工具（逗号分隔）<input aria-label={`角色 ${selectedRole.id} 的允许工具`} value={(selectedRole.allowedTools ?? []).join(", ")} onChange={(event) => updateRole((role) => ({ ...role, allowedTools: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }))} /></label>
              <label><input type="checkbox" checked={selectedRole.disabled ?? false} onChange={(event) => updateRole((role) => ({ ...role, disabled: event.target.checked }))} /> 禁用角色</label>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function uniqueRoleId(baseId: string, roles: WorkflowRoleSummary[]): string {
  const ids = new Set(roles.map((role) => role.id));
  if (!ids.has(baseId)) return baseId;
  let suffix = 2;
  while (ids.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}
