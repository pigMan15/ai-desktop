import type { RuntimeWorkbenchState } from "../../app/runtimeClient";
import type { ReactNode } from "react";

type Props = {
  state: RuntimeWorkbenchState | null;
  projectPath: string;
  onProjectPathChange: (value: string) => void;
  onImport: () => void;
  onArchive?: () => void;
  operationMessage?: string;
  gitPanel?: ReactNode;
};

export function ProjectDashboard({
  state,
  projectPath,
  onProjectPathChange,
  onImport,
  onArchive,
  operationMessage,
  gitPanel,
}: Props) {
  const connected = state?.connection === "connected";
  const initialized = state?.workspaceStatus === "ready";

  return (
    <section id="projects" className="panel panel-wide" aria-labelledby="projects-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Workspace</p>
          <h2 id="projects-title">项目工作区</h2>
        </div>
        <span className="status-pill status-watch">
          {connected ? "Runtime 已连接" : "Runtime 不可用"}
        </span>
      </div>
      {initialized ? (
        <>
          <div className="table-like" role="table" aria-label="项目状态">
            <div role="row" className="table-row table-head">
              <span role="columnheader">项目</span>
              <span role="columnheader">工作流</span>
              <span role="columnheader">当前 Run 状态</span>
            </div>
            <div role="row" className="table-row">
              <span role="cell">{state.projectName}</span>
              <span role="cell">{state.workflowName}</span>
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
          <p className="body-copy">尚未导入项目。选择包含工作流定义的项目目录后即可开始创建 Run。</p>
          <label>
            项目路径
            <input
              value={projectPath}
              onChange={(event) => onProjectPathChange(event.target.value)}
              placeholder="例如 G:\\Project\\my-workflow"
            />
          </label>
          <div className="button-row">
            <button className="quiet-button" disabled={!connected || !projectPath.trim()} onClick={onImport}>
              导入项目
            </button>
          </div>
          {operationMessage ? <p className="body-copy" role="status">{operationMessage}</p> : null}
        </>
      )}
      {initialized && operationMessage ? <p className="body-copy" role="status">{operationMessage}</p> : null}
    </section>
  );
}
