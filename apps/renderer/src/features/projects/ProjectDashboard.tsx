export function ProjectDashboard() {
  return (
    <section id="projects" className="panel panel-wide" aria-labelledby="projects-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Workspace</p>
          <h2 id="projects-title">Project Dashboard</h2>
        </div>
        <span className="status-pill status-watch">2 个阻塞</span>
      </div>
      <p className="body-copy">
        项目导入已接入 Runtime API 路径：Harness workflow 会被规范化、持久化为 workflow version，并用于创建 Run。
      </p>
      <div className="table-like" role="table" aria-label="项目状态">
        <div role="row" className="table-row table-head">
          <span role="columnheader">项目</span>
          <span role="columnheader">当前 run 状态</span>
          <span role="columnheader">阻塞原因</span>
        </div>
        <div role="row" className="table-row">
          <span role="cell">desktop-workflow</span>
          <span role="cell">waiting_for_approval</span>
          <span role="cell">需要用户确认文件写入范围</span>
        </div>
        <div role="row" className="table-row">
          <span role="cell">runtime-contracts</span>
          <span role="cell">collecting_evidence</span>
          <span role="cell">等待测试 evidence 索引</span>
        </div>
      </div>
    </section>
  );
}
