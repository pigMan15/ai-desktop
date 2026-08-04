import { useEffect, useRef, useState } from "react";

import type { RoleAssetSummary, RoleVersionSummary, RoleWorkflowReference, WorkflowRoleSummary } from "../../app/runtimeClient";

type Props = {
  roles: RoleAssetSummary[];
  onSave: (role: WorkflowRoleSummary) => Promise<void>;
  onArchive: (roleId: string) => Promise<void>;
  onRestore: (roleId: string) => Promise<void>;
  onDelete: (roleId: string) => Promise<void>;
  onLoadHistory: (roleId: string) => Promise<RoleVersionSummary[]>;
  onLoadReferences: (roleId: string) => Promise<RoleWorkflowReference[]>;
};

const blankRole = (): WorkflowRoleSummary => ({ id: "", name: "", instructions: "", allowedTools: [] });

function toolsToText(allowedTools: string[] | undefined): string {
  return (allowedTools ?? []).join(", ");
}

function textToTools(value: string): string[] {
  return value.split(",").map((tool) => tool.trim()).filter(Boolean);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function RoleAssetsPage({ roles, onSave, onArchive, onRestore, onDelete, onLoadHistory, onLoadReferences }: Props) {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowRoleSummary>(blankRole);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<RoleVersionSummary[]>([]);
  const [references, setReferences] = useState<RoleWorkflowReference[]>([]);
  const userHasChosenDraft = useRef(false);
  const selectedRole = selectedRoleId ? roles.find((role) => role.id === selectedRoleId) ?? null : null;
  const isNew = selectedRoleId === null;

  useEffect(() => {
    if (!userHasChosenDraft.current && !selectedRoleId && roles[0]) {
      setSelectedRoleId(roles[0].id);
    }
  }, [roles, selectedRoleId]);

  useEffect(() => {
    if (!selectedRole) return;
    setDraft(selectedRole);
  }, [selectedRole]);

  useEffect(() => {
    if (!selectedRoleId) {
      setHistory([]);
      setReferences([]);
      return;
    }
    let active = true;
    Promise.all([onLoadHistory(selectedRoleId), onLoadReferences(selectedRoleId)])
      .then(([nextHistory, nextReferences]) => {
        if (active) {
          setHistory(nextHistory);
          setReferences(nextReferences);
        }
      })
      .catch(() => {
        if (active) {
          setHistory([]);
          setReferences([]);
        }
      });
    return () => { active = false; };
  }, [onLoadHistory, onLoadReferences, selectedRoleId]);

  function createRole() {
    userHasChosenDraft.current = true;
    setSelectedRoleId(null);
    setDraft(blankRole());
    setHistory([]);
    setReferences([]);
  }

  function selectRole(role: RoleAssetSummary) {
    userHasChosenDraft.current = true;
    setSelectedRoleId(role.id);
  }

  async function save() {
    if (!draft.id.trim() || !draft.name.trim()) return;
    const nextRole = { ...draft, id: draft.id.trim(), name: draft.name.trim(), allowedTools: draft.allowedTools ?? [] };
    setSaving(true);
    try {
      await onSave(nextRole);
      userHasChosenDraft.current = true;
      setSelectedRoleId(nextRole.id);
      setDraft(nextRole);
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!selectedRole || selectedRole.archivedAt) return;
    await onArchive(selectedRole.id);
    createRole();
  }

  async function restore() {
    if (!selectedRole || !selectedRole.archivedAt) return;
    await onRestore(selectedRole.id);
  }

  async function remove() {
    if (!selectedRole || selectedRole.isBuiltin) return;
    await onDelete(selectedRole.id);
    createRole();
  }

  return (
    <section className="panel page-workspace role-assets-page" aria-labelledby="role-assets-title">
      <header className="role-assets-header">
        <div>
          <p className="section-kicker">工作流资产</p>
          <h2 id="role-assets-title">角色库</h2>
          <p className="role-assets-intro">统一维护可复用的执行角色。工作流引用角色的已保存版本，不会受后续修改影响。</p>
        </div>
        <button type="button" onClick={createRole}>新建角色</button>
      </header>

      <div className="role-assets-workspace">
        <aside className="role-assets-list" aria-label="公共角色">
          <div className="role-assets-list-heading">
            <strong>全部角色</strong>
            <span>{roles.length}</span>
          </div>
          {roles.length === 0 ? <p className="role-assets-empty">暂无公共角色，先新建一条角色定义。</p> : null}
          <div className="role-assets-list-items" role="list">
            {roles.map((role) => (
              <button
                type="button"
                className={`role-assets-list-item${selectedRoleId === role.id ? " is-selected" : ""}`}
                key={role.id}
                onClick={() => selectRole(role)}
                aria-pressed={selectedRoleId === role.id}
              >
                <span className="role-assets-list-item-title">{role.name}</span>
                <span className="role-assets-list-item-meta"><code>{role.id}</code><span>v{role.version}</span>{role.archivedAt ? <span>已归档</span> : <span>启用中</span>}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="role-assets-editor">
          <div className="role-assets-editor-heading">
            <div>
              <p className="section-kicker">{isNew ? "新角色" : `版本 ${selectedRole?.version ?? "-"}`}</p>
              <h3>{isNew ? "创建角色定义" : draft.name || "未命名角色"}</h3>
            </div>
            {!isNew ? <span className={`role-assets-state${selectedRole?.archivedAt ? " is-archived" : ""}`}>{selectedRole?.archivedAt ? "已归档" : "启用中"}</span> : null}
          </div>

          <div className="role-assets-form">
            <label>角色 ID
              <input aria-label="角色 ID" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} disabled={!isNew} placeholder="例如：developer" />
              <small>{isNew ? "用于工作流绑定，保存后不可修改。" : "角色 ID 是稳定标识；需要新 ID 时请新建角色。"}</small>
            </label>
            <label>名称<input aria-label="名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：开发实现" /></label>
            <label>执行器
              <select value={draft.provider ?? "codex"} onChange={(event) => setDraft({ ...draft, provider: event.target.value as WorkflowRoleSummary["provider"] })}>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label>模型（可选）<input value={draft.model ?? ""} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="由执行器使用默认模型" /></label>
            <label className="role-assets-span-two">职责与目标<textarea value={draft.purpose ?? ""} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} placeholder="说明这个角色负责什么，以及它服务的业务目标。" /></label>
            <label className="role-assets-span-two">执行指令<textarea value={draft.instructions ?? ""} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="写明执行步骤、边界和协作方式。" /></label>
            <label>输入要求<textarea value={draft.inputRequirements ?? ""} onChange={(event) => setDraft({ ...draft, inputRequirements: event.target.value })} placeholder="开始执行前必须具备的信息。" /></label>
            <label>产出要求<textarea value={draft.outputRequirements ?? ""} onChange={(event) => setDraft({ ...draft, outputRequirements: event.target.value })} placeholder="需要交付的结果和格式。" /></label>
            <label>验收标准<textarea value={draft.acceptanceCriteria ?? ""} onChange={(event) => setDraft({ ...draft, acceptanceCriteria: event.target.value })} placeholder="怎样算完成、通过。" /></label>
            <label>禁止操作<textarea value={draft.forbiddenActions ?? ""} onChange={(event) => setDraft({ ...draft, forbiddenActions: event.target.value })} placeholder="明确不能做的操作与越权边界。" /></label>
            <label className="role-assets-span-two">工具权限<input aria-label="工具权限" value={toolsToText(draft.allowedTools)} onChange={(event) => setDraft({ ...draft, allowedTools: textToTools(event.target.value) })} placeholder="例如：read, write, test" /><small>用英文逗号分隔。空白时不附加工具限制。</small></label>
          </div>

          <div className="role-assets-actions">
            <button type="button" onClick={() => void save()} disabled={saving || !draft.id.trim() || !draft.name.trim() || Boolean(selectedRole?.archivedAt)}>{saving ? "保存中..." : "保存新版本"}</button>
            {!isNew && !selectedRole?.archivedAt ? <button type="button" className="quiet-button" onClick={() => void archive()}>归档角色</button> : null}
            {!isNew && selectedRole?.archivedAt ? <button type="button" className="quiet-button" onClick={() => void restore()}>恢复使用</button> : null}
            {!isNew && !selectedRole?.isBuiltin ? <button type="button" className="quiet-button" onClick={() => void remove()}>删除角色</button> : null}
          </div>

          {!isNew ? <div className="role-assets-details">
            <section aria-label="角色版本历史"><h4>版本历史</h4>{history.length ? <ul className="compact-list">{history.map((item) => <li key={item.roleVersionId}><strong>v{item.version}</strong><span>{formatDate(item.createdAt)}</span></li>)}</ul> : <p>尚无可展示的版本记录。</p>}</section>
            <section aria-label="工作流引用"><h4>工作流引用</h4>{references.length ? <ul className="compact-list">{references.map((item) => <li key={item.workflowVersionId}><strong>{item.workflowName}</strong><span>工作流版本 {item.workflowVersion}</span></li>)}</ul> : <p>当前没有工作流引用这个角色。</p>}</section>
          </div> : null}
        </div>
      </div>
    </section>
  );
}
