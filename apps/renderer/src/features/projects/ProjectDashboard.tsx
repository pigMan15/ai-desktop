import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = { state: RuntimeWorkbenchState | null };

export function ProjectDashboard({ state }: Props) {
  const connectionText =
    state?.connection === "connected" ? "Runtime API 已连接" : "Runtime API 不可用";

  return (
    <section id="projects" className="panel panel-wide" aria-labelledby="projects-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Workspace</p>
          <h2 id="projects-title">Project Dashboard</h2>
        </div>
        <span className="status-pill status-watch">{connectionText}</span>
      </div>
      <p className="body-copy">
        项目导入已接入 Runtime API 路径，Renderer 展示 Runtime 返回的项目、工作流和 Run 投影。
      </p>
      <div className="table-like" role="table" aria-label="项目状态">
        <div role="row" className="table-row table-head">
          <span role="columnheader">项目</span>
          <span role="columnheader">工作流</span>
          <span role="columnheader">当前 Run 状态</span>
        </div>
        <div role="row" className="table-row">
          <span role="cell">{state?.projectName ?? "加载中"}</span>
          <span role="cell">{state?.workflowName ?? "加载中"}</span>
          <span role="cell">{state?.projection.status ?? "加载中"}</span>
        </div>
      </div>
    </section>
  );
}
