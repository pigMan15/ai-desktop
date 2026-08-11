import { useEffect, useState } from "react";
import type { ProjectConcurrencySettings } from "@workflow-platform/contracts";
import type { AgentProviderDiagnostic, ModelProviderSettings, ModelProviderSettingsInput } from "../../app/runtimeClient";

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
  projectConcurrency?: ProjectConcurrencySettings | null;
  onSaveProjectConcurrency?: (settings: ProjectConcurrencySettings) => Promise<void>;
  modelProvider?: ModelProviderSettings | null;
  onSaveModelProvider?: (settings: ModelProviderSettingsInput) => Promise<void>;
  onTestModelProvider?: (settings: ModelProviderSettingsInput | null) => Promise<{ ok: boolean; message: string; latencyMs?: number | null } | null>;
  savingModelProvider?: boolean;
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

const MODEL_VENDOR_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
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
  projectConcurrency,
  onSaveProjectConcurrency,
  modelProvider,
  onSaveModelProvider,
  onTestModelProvider,
  savingModelProvider = false,
}: Props) {
  const connected = connection === "connected";
  const [concurrencyDraft, setConcurrencyDraft] = useState(projectConcurrency);
  const [savingConcurrency, setSavingConcurrency] = useState(false);

  useEffect(() => setConcurrencyDraft(projectConcurrency), [projectConcurrency]);

  const [modelDraft, setModelDraft] = useState<ModelProviderSettingsInput>({
    vendor: modelProvider?.vendor ?? "openai",
    baseUrl: modelProvider?.baseUrl ?? "https://api.openai.com/v1",
    apiKey: "",
    model: modelProvider?.model ?? "gpt-4o-mini",
    temperature: modelProvider?.temperature ?? 0.7,
    systemPrompt: modelProvider?.systemPrompt ?? "",
  });
  const [testingModelProvider, setTestingModelProvider] = useState(false);
  const [modelProviderTestResult, setModelProviderTestResult] = useState<string | null>(null);
  const [modelProviderTestOk, setModelProviderTestOk] = useState<boolean | null>(null);

  useEffect(() => {
    setModelDraft({
      vendor: modelProvider?.vendor ?? "openai",
      baseUrl: modelProvider?.baseUrl ?? "https://api.openai.com/v1",
      apiKey: "",
      model: modelProvider?.model ?? "gpt-4o-mini",
      temperature: modelProvider?.temperature ?? 0.7,
      systemPrompt: modelProvider?.systemPrompt ?? "",
    });
  }, [modelProvider]);

  const handleVendorChange = (vendor: string) => {
    const preset = MODEL_VENDOR_PRESETS[vendor];
    setModelDraft((current) => ({
      ...current,
      vendor,
      ...(preset ? { baseUrl: preset.baseUrl, model: preset.model } : {}),
    }));
  };

  const handleSaveModelProvider = async () => {
    if (!onSaveModelProvider) return;
    setModelProviderTestResult(null);
    try {
      await onSaveModelProvider(modelDraft);
      setModelProviderTestResult("模型直连配置已保存");
      setModelProviderTestOk(true);
    } catch (error) {
      setModelProviderTestResult(error instanceof Error ? error.message : "保存失败");
      setModelProviderTestOk(false);
    }
  };

  const handleTestModelProvider = async () => {
    if (!onTestModelProvider) return;
    setTestingModelProvider(true);
    setModelProviderTestResult(null);
    try {
      const result = await onTestModelProvider(modelDraft);
      if (result) {
        setModelProviderTestResult(result.message);
        setModelProviderTestOk(result.ok);
      }
    } catch (error) {
      setModelProviderTestResult(error instanceof Error ? error.message : "测试失败");
      setModelProviderTestOk(false);
    } finally {
      setTestingModelProvider(false);
    }
  };


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
      {concurrencyDraft && onSaveProjectConcurrency ? (
        <fieldset className="settings-concurrency">
          <legend>项目并发限制</legend>
          <label>
            活动 Run 上限
            <input
              type="number"
              min={1}
              max={10}
              value={concurrencyDraft.maxActiveRuns}
              onChange={(event) => setConcurrencyDraft({ ...concurrencyDraft, maxActiveRuns: Number(event.target.value) })}
            />
          </label>
          <label>
            每 Run 活动 Agent 上限
            <input
              type="number"
              min={1}
              max={10}
              value={concurrencyDraft.maxActiveAgents}
              onChange={(event) => setConcurrencyDraft({ ...concurrencyDraft, maxActiveAgents: Number(event.target.value) })}
            />
          </label>
          <button
            className="quiet-button"
            type="button"
            disabled={savingConcurrency || !validConcurrency(concurrencyDraft)}
            onClick={() => {
              setSavingConcurrency(true);
              void onSaveProjectConcurrency(concurrencyDraft).finally(() => setSavingConcurrency(false));
            }}
          >
            {savingConcurrency ? "正在保存..." : "保存并发限制"}
          </button>
        </fieldset>
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
      <fieldset className="settings-model-provider">
        <legend>模型直连（OpenAI 兼容）</legend>
        <p className="body-copy">配置后可在 Agent 面板选择「模型直连」并进入聊天模式，无需安装 Agent CLI。</p>
        <label>
          模型厂商
          <select value={modelDraft.vendor} onChange={(event) => handleVendorChange(event.target.value)}>
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">通义千问（DashScope）</option>
            <option value="moonshot">Moonshot Kimi</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label>
          Base URL
          <input value={modelDraft.baseUrl} onChange={(event) => setModelDraft({ ...modelDraft, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
        </label>
        <label>
          API Key
          <input type="password" value={modelDraft.apiKey ?? ""} onChange={(event) => setModelDraft({ ...modelDraft, apiKey: event.target.value })} placeholder={modelProvider?.hasApiKey ? "已保存（留空保持不变）" : "sk-..."} />
        </label>
        <label>
          模型名称
          <input value={modelDraft.model} onChange={(event) => setModelDraft({ ...modelDraft, model: event.target.value })} placeholder="gpt-4o-mini" />
        </label>
        <label>
          温度
          <input type="number" min={0} max={2} step={0.1} value={modelDraft.temperature ?? 0.7} onChange={(event) => setModelDraft({ ...modelDraft, temperature: Number(event.target.value) })} />
        </label>
        <label>
          系统提示词
          <textarea value={modelDraft.systemPrompt ?? ""} onChange={(event) => setModelDraft({ ...modelDraft, systemPrompt: event.target.value })} rows={2} />
        </label>
        <div className="button-row">
          <button className="knowledge-button--primary" type="button" disabled={savingModelProvider || !onSaveModelProvider || !modelDraft.baseUrl.trim() || !modelDraft.model.trim()} onClick={() => void handleSaveModelProvider()}>
            {savingModelProvider ? "保存中..." : "保存配置"}
          </button>
          <button className="quiet-button" type="button" disabled={testingModelProvider || !onTestModelProvider || !modelDraft.baseUrl.trim() || !modelDraft.model.trim()} onClick={() => void handleTestModelProvider()}>
            {testingModelProvider ? "测试中..." : "测试连接"}
          </button>
        </div>
        {modelProviderTestResult ? (
          <p className={`status-line ${modelProviderTestOk ? "status-watch" : "status-blocked"}`} aria-live="polite">
            {modelProviderTestResult}
          </p>
        ) : null}
      </fieldset>
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

function validConcurrency(settings: ProjectConcurrencySettings): boolean {
  return Number.isInteger(settings.maxActiveRuns)
    && Number.isInteger(settings.maxActiveAgents)
    && settings.maxActiveRuns >= 1
    && settings.maxActiveRuns <= 10
    && settings.maxActiveAgents >= 1
    && settings.maxActiveAgents <= 10;
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
