import type { AgentProviderDiagnostic } from "../../app/runtimeClient";

type Props = {
  apiBaseUrl: string;
  connection: "connected" | "unavailable";
  onApiBaseUrlChange: (value: string) => void;
  onCheckConnection: () => void;
  managedRuntime?: ManagedRuntimeStatus | null;
  runtimeLogs?: RuntimeLogEntry[];
  onRestartManagedRuntime?: () => void;
  onDownloadDiagnostics?: () => void;
  operationMessage?: string;
  providerDiagnostics?: AgentProviderDiagnostic[];
  onRefreshProviderDiagnostics?: () => void;
};

export type ManagedRuntimeStatus = {
  mode: "external" | "managed";
  state: "stopped" | "starting" | "ready" | "failed";
  url: string;
  port: number;
  pid: number | null;
  lastError: string | null;
};

export type RuntimeLogEntry = {
  level: "info" | "error";
  message: string;
  createdAt: string;
};

export function SettingsPage({
  apiBaseUrl,
  connection,
  onApiBaseUrlChange,
  onCheckConnection,
  managedRuntime,
  runtimeLogs = [],
  onRestartManagedRuntime,
  onDownloadDiagnostics,
  operationMessage,
  providerDiagnostics,
  onRefreshProviderDiagnostics,
}: Props) {
  const connected = connection === "connected";

  return (
    <section id="settings" className="panel page-workspace page-settings" aria-labelledby="settings-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">配置</p>
          <h2 id="settings-title">运行时设置</h2>
        </div>
        <span className={`status-pill ${connected ? "status-watch" : "status-blocked"}`}>
          {connected ? "Runtime 已连接" : "Runtime 不可用"}
        </span>
      </div>
      <p className="body-copy">配置本地 Runtime 的服务地址，并在导入项目或执行工作流前确认连接状态。</p>
      <label>
        Runtime API 地址
        <input
          value={apiBaseUrl}
          onChange={(event) => onApiBaseUrlChange(event.target.value)}
          placeholder="例如 http://127.0.0.1:8765"
        />
      </label>
      <div className="button-row">
        <button className="quiet-button" onClick={onCheckConnection}>
          检测连接
        </button>
      </div>
      {operationMessage ? (
        <p className="status-line" aria-live="polite">
          {operationMessage}
        </p>
      ) : null}
      {managedRuntime ? (
        <>
          <div className="panel-heading">
            <div>
              <p className="section-kicker">桌面服务</p>
              <h3>受管 Runtime</h3>
            </div>
            <span
              className={`status-pill ${
                managedRuntime.state === "ready" ? "status-watch" : "status-blocked"
              }`}
            >
              {runtimeStateLabel(managedRuntime.state)}
            </span>
          </div>
          <dl className="facts">
            <div>
              <dt>服务地址</dt>
              <dd>{managedRuntime.url}</dd>
            </div>
            <div>
              <dt>进程 ID</dt>
              <dd>{managedRuntime.pid ?? "未启动"}</dd>
            </div>
            <div>
              <dt>最后错误</dt>
              <dd>{managedRuntime.lastError ?? "无"}</dd>
            </div>
          </dl>
          {onRestartManagedRuntime || onDownloadDiagnostics ? (
            <div className="button-row">
              {onRestartManagedRuntime ? (
                <button className="quiet-button" onClick={onRestartManagedRuntime}>
                  重启 Runtime
                </button>
              ) : null}
              {onDownloadDiagnostics ? (
                <button className="quiet-button" onClick={onDownloadDiagnostics}>
                  下载诊断支持包
                </button>
              ) : null}
            </div>
          ) : null}
          <ul className="compact-list" aria-label="Runtime 诊断日志">
            {runtimeLogs.map((entry) => (
              <li key={`${entry.createdAt}-${entry.message}`}>
                {entry.level === "error" ? "错误" : "信息"}：{entry.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {providerDiagnostics && providerDiagnostics.length > 0 ? (
        <>
          <div className="panel-heading">
            <div>
              <p className="section-kicker">执行器</p>
              <h3>CLI 可用性诊断</h3>
            </div>
          </div>
          {onRefreshProviderDiagnostics ? (
            <div className="button-row">
              <button className="quiet-button" onClick={onRefreshProviderDiagnostics}>
                重新检测 CLI
              </button>
            </div>
          ) : null}
          <ul className="compact-list" aria-label="CLI 可用性诊断">
            {providerDiagnostics.map((diagnostic) => (
              <li key={diagnostic.id}>
                <strong>{providerLabel(diagnostic.id)}：{diagnostic.message}</strong>
                <span className={`status-pill ${diagnostic.available ? "status-watch" : "status-blocked"}`}>
                  {diagnostic.available ? "可用" : "不可用"}
                </span>
                <span>可执行文件：{diagnostic.executable}</span>
                {diagnostic.version ? <span>版本：{diagnostic.version}</span> : null}
                {diagnostic.path ? <span>路径：{diagnostic.path}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function providerLabel(provider: AgentProviderDiagnostic["id"]): string {
  return provider === "codex" ? "Codex CLI" : "Claude Code CLI";
}

function runtimeStateLabel(state: ManagedRuntimeStatus["state"]): string {
  switch (state) {
    case "ready":
      return "运行正常";
    case "starting":
      return "正在启动";
    case "stopped":
      return "已停止";
    case "failed":
      return "启动失败";
  }
}
