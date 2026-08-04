import { useMemo, useState } from "react";

import type { WorkflowLibraryItem } from "../../app/runtimeClient";

type Props = {
  workflows: WorkflowLibraryItem[];
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onEdit: (workflow: WorkflowLibraryItem) => void;
  onCopyTemplate: (workflow: WorkflowLibraryItem, name: string) => void;
  onDelete: (workflow: WorkflowLibraryItem) => void;
  onRefresh: () => void;
};

export function WorkflowLibraryPage({
  workflows,
  loading,
  error,
  onCreate,
  onEdit,
  onCopyTemplate,
  onDelete,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "builtin" | "custom">("all");
  const [templateNames, setTemplateNames] = useState<Record<string, string>>({});
  const visibleWorkflows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return workflows.filter((workflow) => {
      const matchesScope = scope === "all" || (scope === "builtin" ? workflow.isBuiltin : !workflow.isBuiltin);
      return matchesScope && (!normalizedQuery || workflow.name.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [query, scope, workflows]);

  return (
    <section id="workflow" className="panel page-workspace page-workflow-library" aria-labelledby="workflow-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">工作流</p>
          <h2 id="workflow-title">工作流视图</h2>
        </div>
        <div className="button-row workflow-library-actions">
          <button type="button" className="quiet-button" onClick={onRefresh} disabled={loading}>刷新</button>
          <button type="button" onClick={onCreate}>新建工作流</button>
        </div>
      </div>
      <div className="workflow-library-filters" aria-label="工作流筛选">
        <label>
          搜索
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称搜索" />
        </label>
        <label>
          类型
          <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="all">全部工作流</option>
            <option value="custom">我的工作流</option>
            <option value="builtin">内置模板</option>
          </select>
        </label>
      </div>
      {loading ? <p className="body-copy" role="status">正在加载工作流...</p> : null}
      {error ? <p className="body-copy" role="alert">{error}</p> : null}
      {!loading && !error && visibleWorkflows.length === 0 ? (
        <div className="workflow-library-empty">
          <strong>{workflows.length === 0 ? "还没有工作流" : "没有匹配的工作流"}</strong>
          <p className="body-copy">新建业务工作流，或基于内置模板创建后再进行编排。</p>
          {workflows.length === 0 ? <button type="button" onClick={onCreate}>新建工作流</button> : null}
        </div>
      ) : null}
      {!loading && visibleWorkflows.length > 0 ? (
        <div className="workflow-library-list" role="list" aria-label="已保存工作流">
          {visibleWorkflows.map((workflow) => {
            const copyName = templateNames[workflow.workflowId] ?? `${workflow.name}副本`;
            return (
              <article className="workflow-library-row" role="listitem" key={workflow.workflowId}>
                <div className="workflow-library-main">
                  <div className="workflow-library-title">
                    <strong>{workflow.name}</strong>
                    {workflow.isBuiltin ? <span className="status-pill">内置模板</span> : null}
                    {workflow.archivedAt ? <span className="status-pill">已归档</span> : null}
                  </div>
                  <span>版本 {workflow.currentVersion ?? "未保存"}</span>
                  <span>{workflow.nodeCount} 个节点</span>
                  <span>{workflow.boundProjectCount} 个绑定项目</span>
                  <span>更新于 {formatUpdatedAt(workflow.updatedAt)}</span>
                </div>
                <div className="workflow-library-row-actions">
                  {workflow.isBuiltin ? (
                    <>
                      <label className="workflow-template-name">
                        <span className="sr-only">复制{workflow.name}后的工作流名称</span>
                        <input
                          aria-label={`复制${workflow.name}后的工作流名称`}
                          value={copyName}
                          onChange={(event) => setTemplateNames((current) => ({ ...current, [workflow.workflowId]: event.target.value }))}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => onCopyTemplate(workflow, copyName.trim() || `${workflow.name}副本`)}
                        disabled={Boolean(workflow.archivedAt)}
                      >
                        基于模板新建 {workflow.name}
                      </button>
                    </>
                  ) : (
                    <>
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => onEdit(workflow)}
                      disabled={Boolean(workflow.archivedAt) || !workflow.workflowVersionId}
                    >
                      编辑 {workflow.name}
                    </button>
                    <button type="button" className="quiet-button" onClick={() => onDelete(workflow)}>删除</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
