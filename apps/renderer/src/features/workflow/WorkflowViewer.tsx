export function WorkflowViewer() {
  return (
    <section id="workflow" className="panel" aria-labelledby="workflow-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Graph</p>
          <h2 id="workflow-title">Workflow Viewer</h2>
        </div>
        <span className="status-pill">只读</span>
      </div>
      <p className="body-copy">
        只读呈现节点、依赖和等待中的 gate，用于查看工作流是否因审批、测试或 evidence 缺失停顿。
      </p>
      <ol className="timeline">
        <li><span>Plan</span><strong>完成，evidence 已记录</strong></li>
        <li><span>Implement</span><strong>进行中，等待测试信号</strong></li>
        <li><span>Review Gate</span><strong>阻塞，需要 Runtime 判定</strong></li>
      </ol>
    </section>
  );
}
