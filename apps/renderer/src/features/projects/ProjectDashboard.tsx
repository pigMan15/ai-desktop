import type { ProjectWorkflowBinding, RuntimeWorkbenchState } from "../../app/runtimeClient";
import type { ReactNode } from "react";

type Props = {
  state: RuntimeWorkbenchState | null;
  projectPath: string;
  onProjectPathChange: (value: string) => void;
  onImport: () => void;
  onSelectDirectory?: () => void;
  onArchive?: () => void;
  archived?: boolean;
  onReimport?: () => void;
  operationMessage?: string;
  gitPanel?: ReactNode;
  workflowBindingStep?: ReactNode;
  workflowBinding?: ProjectWorkflowBinding | null;
};

export function ProjectDashboard({
  state,
  projectPath,
  onProjectPathChange,
  onImport,
  onSelectDirectory,
  onArchive,
  archived = false,
  onReimport,
  operationMessage,
  gitPanel,
  workflowBindingStep,
  workflowBinding = null,
}: Props) {
  const connected = state?.connection === "connected";
  const initialized = state?.workspaceStatus === "ready";
  const workflowName = workflowBinding && state?.workflowName?.includes("未绑定")
    ? "已绑定工作流"
    : state?.workflowName ?? "未绑定工作流";

  return (
    <section id="projects" className="panel panel-wide page-workspace page-projects" aria-labelledby="projects-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Workspace</p>
          <h2 id="projects-title">项目工作区</h2>
        </div>
        <span className="status-pill status-watch">
          {connected ? "Runtime 已连接" : "Runtime 不可用"}
        </span>
      </div>
      {archived ? (
        <>
          <p className="body-copy">项目已归档。历史 Run、产物和知识记录会保留；重新导入目录后即可恢复为活动项目。</p>
          <label>
            项目路径
            <input
              value={projectPath}
              onChange={(event) => onProjectPathChange(event.target.value)}
              placeholder="例如 G:\\Project\\my-workflow"
            />
          </label>
          <div className="button-row">
            {onSelectDirectory ? <button className="quiet-button" onClick={onSelectDirectory}>选择项目目录</button> : null}
            <button className="quiet-button" disabled={!connected || !projectPath.trim() || !onReimport} onClick={onReimport}>
              重新导入项目
            </button>
          </div>
        </>
      ) : initialized ? (
        <>
          {workflowBindingStep}
          {operationMessage ? <p className="body-copy project-operation-message" role="status">{operationMessage}</p> : null}
          <div className="table-like" role="table" aria-label="项目状态">
            <div role="row" className="table-row table-head">
              <span role="columnheader">项目</span>
              <span role="columnheader">工作流</span>
              <span role="columnheader">当前 Run 状态</span>
            </div>
            <div role="row" className="table-row">
              <span role="cell">{state.projectName}</span>
              <span role="cell">{workflowName}</span>
              <span role="cell">{state.projection?.status ?? "尚未创建 Run"}</span>
            </div>
          </div>
          <div className="button-row">
            <button className="quiet-button" disabled={!onArchive} onClick={onArchive}>
              归档项目
            </button>
          </div>
          {gitPanel}
        </>
      ) : (
        <>
          <p className="body-copy">选择任意项目目录即可导入。没有工作流文件时，导入后请选择已有工作流，或新建符合业务的工作流再绑定。</p>
          <label>
            项目路径
            <input
              value={projectPath}
              onChange={(event) => onProjectPathChange(event.target.value)}
              placeholder="例如 G:\\Project\\my-workflow"
            />
          </label>
          <div className="button-row">
            {onSelectDirectory ? <button className="quiet-button" onClick={onSelectDirectory}>选择项目目录</button> : null}
            <button className="quiet-button" disabled={!connected || !projectPath.trim()} onClick={onImport}>
              导入项目
            </button>
          </div>
          {operationMessage ? <p className="body-copy" role="status">{operationMessage}</p> : null}
        </>
      )}
    </section>
  );
}
