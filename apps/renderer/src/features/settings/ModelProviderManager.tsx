import { useEffect, useState, type CSSProperties } from "react";
import { Eye, EyeOff, Pencil, Plus, Star, Trash2 } from "lucide-react";
import type { ModelProviderInput, ModelProviderRecord } from "../../app/runtimeClient";

type TestResult = { ok: boolean; message: string; latencyMs?: number | null };

type Props = {
  providers: ModelProviderRecord[];
  activeProviderId: string | null;
  saving: boolean;
  testing: boolean;
  onSave(providerId: string | null, input: ModelProviderInput): Promise<void>;
  onDelete(providerId: string): Promise<void>;
  onSetDefault(providerId: string): Promise<void>;
  onTest(providerId: string | null, input: ModelProviderInput | null): Promise<TestResult | null>;
};

const MODEL_VENDORS: Record<string, { label: string; baseUrl: string; model: string; color: string }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", color: "#10a37f" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", color: "#4d6bfe" },
  qwen: { label: "通义千问（DashScope）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", color: "#615ced" },
  moonshot: { label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", color: "#1f2937" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", color: "#8b5cf6" },
  custom: { label: "自定义", baseUrl: "", model: "", color: "#64748b" },
};

const emptyDraft = (): ModelProviderInput => ({
  name: "",
  vendor: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: null,
  topP: null,
  systemPrompt: "",
});

const fromRecord = (provider: ModelProviderRecord): ModelProviderInput => ({
  name: provider.name,
  vendor: provider.vendor,
  baseUrl: provider.baseUrl,
  apiKey: "",
  model: provider.model,
  temperature: provider.temperature,
  maxTokens: provider.maxTokens,
  topP: provider.topP,
  systemPrompt: provider.systemPrompt,
});

function vendorColor(vendor: string): string {
  return MODEL_VENDORS[vendor]?.color ?? "#64748b";
}

function vendorLabel(vendor: string): string {
  return MODEL_VENDORS[vendor]?.label ?? vendor;
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function ModelProviderManager({
  providers,
  activeProviderId,
  saving,
  testing,
  onSave,
  onDelete,
  onSetDefault,
  onTest,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelProviderInput>(emptyDraft());
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);

  useEffect(() => {
    if (editingId !== null && editingId !== "new") {
      const provider = providers.find((candidate) => candidate.id === editingId);
      if (provider) {
        setDraft(fromRecord(provider));
        setResult(null);
      }
    }
  }, [editingId, providers]);

  const openNew = () => {
    setEditingId("new");
    setDraft(emptyDraft());
    setResult(null);
    setConfirmDeleteId(null);
  };

  const openEdit = (provider: ModelProviderRecord) => {
    setEditingId(provider.id);
    setDraft(fromRecord(provider));
    setResult(null);
    setConfirmDeleteId(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    setResult(null);
  };

  const handleVendorChange = (vendor: string) => {
    const preset = MODEL_VENDORS[vendor];
    setDraft((current) => ({
      ...current,
      vendor,
      ...(preset ? { baseUrl: preset.baseUrl, model: preset.model } : {}),
    }));
  };

  const handleSave = async () => {
    if (!draft.baseUrl.trim() || !draft.model.trim()) return;
    setLocalBusy(true);
    setResult(null);
    try {
      await onSave(editingId === "new" ? null : editingId, draft);
      setResult({ ok: true, message: "已保存" });
      setEditingId(null);
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleTest = async () => {
    setLocalBusy(true);
    setResult(null);
    try {
      const outcome = await onTest(editingId === "new" ? null : editingId, draft);
      if (outcome) setResult(outcome);
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleDeleteClick = (providerId: string) => {
    if (confirmDeleteId !== providerId) {
      setConfirmDeleteId(providerId);
      return;
    }
    setConfirmDeleteId(null);
    void onDelete(providerId);
  };

  const busy = localBusy || saving || testing;

  return (
    <section className="model-providers" aria-labelledby="model-providers-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">模型服务</p>
          <h3 id="model-providers-title">模型直连（OpenAI 兼容）</h3>
        </div>
        <button
          type="button"
          className="knowledge-button--primary"
          disabled={busy}
          onClick={openNew}
        >
          <Plus size={15} aria-hidden="true" />
          添加服务
        </button>
      </div>
      <p className="body-copy">配置后可在 Agent 面板选择「模型直连」并进入聊天模式，无需安装 Agent CLI。可配置多个服务并设置默认。</p>

      {providers.length === 0 && editingId === null ? (
        <p className="model-providers-empty">还没有模型服务，点击「添加服务」配置第一个。</p>
      ) : null}

      {providers.length > 0 ? (
        <ul className="model-provider-list" aria-label="模型服务列表">
          {providers.map((provider) => (
            <li key={provider.id} className="model-provider-card" data-testid={`model-provider-${provider.id}`}>
              <span
                className="model-provider-avatar"
                style={{ "--vendor-color": vendorColor(provider.vendor) } as CSSProperties}
              >
                {initialOf(provider.name)}
              </span>
              <div className="model-provider-card-body">
                <strong>{provider.name}</strong>
                <span className="model-provider-meta">
                  {vendorLabel(provider.vendor)} · {provider.model}
                </span>
                <span className={`status-pill ${provider.available ? "status-watch" : "status-blocked"}`}>
                  {provider.available ? "可用" : provider.message}
                </span>
              </div>
              <div className="model-provider-card-actions">
                {provider.isDefault ? (
                  <span className="status-pill status-watch">
                    <Star size={12} aria-hidden="true" /> 默认
                  </span>
                ) : (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={busy}
                    onClick={() => void onSetDefault(provider.id)}
                  >
                    设为默认
                  </button>
                )}
                <button type="button" className="quiet-button" disabled={busy} onClick={() => openEdit(provider)}>
                  <Pencil size={13} aria-hidden="true" /> 编辑
                </button>
                <button
                  type="button"
                  className={confirmDeleteId === provider.id ? "danger-button" : "quiet-button"}
                  disabled={busy}
                  onClick={() => handleDeleteClick(provider.id)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  {confirmDeleteId === provider.id ? "确认删除？" : "删除"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {editingId !== null ? (
        <fieldset className="model-provider-editor">
          <legend>{editingId === "new" ? "新建模型服务" : "编辑模型服务"}</legend>
          <label>
            服务名称
            <input value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 DeepSeek 主服务" />
          </label>
          <label>
            模型厂商
            <select value={draft.vendor} onChange={(event) => handleVendorChange(event.target.value)}>
              {Object.entries(MODEL_VENDORS).map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </select>
          </label>
          <label>
            Base URL
            <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            API Key
            <span className="model-provider-key-row">
              <input
                type={apiKeyVisible ? "text" : "password"}
                value={draft.apiKey ?? ""}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                placeholder="已保存（留空保持不变）"
              />
              <button
                type="button"
                className="quiet-button"
                aria-label={apiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
                onClick={() => setApiKeyVisible((current) => !current)}
              >
                {apiKeyVisible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              </button>
            </span>
          </label>
          <label>
            模型名称
            <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="gpt-4o-mini" />
          </label>
          <details className="model-provider-advanced">
            <summary>高级参数</summary>
            <div className="model-provider-advanced-grid">
              <label>
                温度
                <input type="number" min={0} max={2} step={0.1} value={draft.temperature ?? 0.7} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} />
              </label>
              <label>
                最大 Tokens
                <input type="number" min={1} value={draft.maxTokens ?? ""} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value === "" ? null : Number(event.target.value) })} placeholder="默认" />
              </label>
              <label>
                Top P
                <input type="number" min={0} max={1} step={0.05} value={draft.topP ?? ""} onChange={(event) => setDraft({ ...draft, topP: event.target.value === "" ? null : Number(event.target.value) })} placeholder="默认" />
              </label>
            </div>
            <label>
              系统提示词
              <textarea value={draft.systemPrompt ?? ""} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} rows={2} placeholder="可留空，使用默认提示词" />
            </label>
          </details>
          {result ? (
            <p className={`status-line ${result.ok ? "status-watch" : "status-blocked"}`} aria-live="polite">
              {result.message}
            </p>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="knowledge-button--primary"
              disabled={busy || !draft.baseUrl.trim() || !draft.model.trim()}
              onClick={() => void handleSave()}
            >
              {busy ? "保存中..." : "保存配置"}
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={busy || !draft.baseUrl.trim() || !draft.model.trim()}
              onClick={() => void handleTest()}
            >
              {busy ? "测试中..." : "测试连接"}
            </button>
            <button type="button" className="quiet-button" disabled={busy} onClick={closeEditor}>
              取消
            </button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}
