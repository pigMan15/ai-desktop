import { useEffect, useState } from "react";

import type { ProjectWorkflowBinding, WorkflowLibraryItem } from "../../app/runtimeClient";

type Props = {
  projectId: string;
  workflows: WorkflowLibraryItem[];
  binding: ProjectWorkflowBinding | null;
  selectedWorkflowId?: string | null;
  loading?: boolean;
  onBind: (workflowId: string, workflowVersionId: string) => void;
  onCopyTemplate: (workflow: WorkflowLibraryItem) => void;
  onCreateBusinessWorkflow: () => void;
};

export function WorkflowBindingStep({
  projectId,
  workflows,
  binding,
  selectedWorkflowId = null,
  loading = false,
  onBind,
  onCopyTemplate,
  onCreateBusinessWorkflow,
}: Props) {
  const [selectedId, setSelectedId] = useState(selectedWorkflowId);
  const [changingBinding, setChangingBinding] = useState(false);

  useEffect(() => {
    setSelectedId(selectedWorkflowId);
  }, [selectedWorkflowId]);

  useEffect(() => {
    setChangingBinding(false);
  }, [binding?.workflowVersionId]);

  if (binding && !changingBinding) {
    return (
      <section className="workflow-binding-step" aria-label="项目工作流绑定">
        <strong>已绑定工作流</strong>
        <p className="body-copy">当前项目已固定到版本 {binding.workflowVersionId}，新建 Run 将使用该版本。</p>
        <div className="button-row">
          <button type="button" className="quiet-button" onClick={() => setChangingBinding(true)}>
            更换工作流
          </button>
        </div>
      </section>
    );
  }

  const availableWorkflows = workflows.filter((workflow) => !workflow.archivedAt && workflow.workflowVersionId);
  return (
    <section className="workflow-binding-step" aria-labelledby="workflow-binding-title">
      <div>
        <p className="section-kicker">工作流绑定</p>
        <h3 id="workflow-binding-title">选择工作流</h3>
      </div>
      <p className="body-copy">
        项目“{projectId}”未包含可用工作流。请选择已有工作流，或先新建符合业务的工作流后再绑定。
      </p>
      {loading ? <p className="body-copy" role="status">正在加载可绑定工作流...</p> : null}
      <div className="workflow-binding-list" role="list" aria-label="可绑定工作流">
        {availableWorkflows.map((workflow) => (
          <article key={workflow.workflowId} role="listitem" className="workflow-binding-row" data-selected={selectedId === workflow.workflowId}>
            <div>
              <strong>{workflow.name}</strong>
              <span>版本 {workflow.currentVersion ?? "未保存"}</span>
              <span>{workflow.nodeCount} 个节点</span>
              {workflow.isBuiltin ? <span className="status-pill">内置模板</span> : null}
            </div>
            {workflow.isBuiltin ? (
              <button type="button" onClick={() => onCopyTemplate(workflow)}>
                基于{workflow.name}新建并绑定
              </button>
            ) : (
              <button type="button" className="quiet-button" onClick={() => onBind(workflow.workflowId, workflow.workflowVersionId!)}>
                绑定{workflow.name}
              </button>
            )}
          </article>
        ))}
      </div>
      {availableWorkflows.length === 0 && !loading ? <p className="body-copy">还没有可绑定的工作流。</p> : null}
      <div className="button-row">
        {binding ? (
          <button type="button" className="quiet-button" onClick={() => setChangingBinding(false)}>
            保留当前绑定
          </button>
        ) : null}
        <button type="button" onClick={onCreateBusinessWorkflow}>新建业务工作流</button>
      </div>
    </section>
  );
}
