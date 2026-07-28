export function TerminalPage() {
  return (
    <section id="terminal" className="panel" aria-labelledby="terminal-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Shell</p>
          <h2 id="terminal-title">Terminal</h2>
        </div>
        <span className="status-pill">detached</span>
      </div>
      <p className="body-copy">
        终端输出等待 Runtime 会话接入；MVP 仅显示命令、退出码和 evidence 采集位置。
      </p>
      <pre className="terminal-readout" aria-label="终端占位输出">{`$ npm run verify
状态: 等待 Runtime terminal backend
evidence: 未生成`}</pre>
    </section>
  );
}
