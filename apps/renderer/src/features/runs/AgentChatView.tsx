import { useEffect, useRef, useState } from "react";
import type { AgentPermissionRequest } from "@workflow-platform/contracts";
import type { AgentChatMessage } from "./runAgentExecutorModel";
import { ChatMarkdown } from "./ChatMarkdown";

const toolStatusLabel = (status: string | undefined): string => {
  if (status === "running") return "执行中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return status || "执行";
};

type Props = {
  jobLabel: string;
  messages: AgentChatMessage[];
  permissions: AgentPermissionRequest[];
  disabled: boolean;
  onSend(message: string): Promise<void> | void;
  onDecide(requestId: string, decision: "allow" | "deny", reason?: string): Promise<void> | void;
};

export function AgentChatView({ jobLabel, messages, permissions, disabled, onSend, onDecide }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, permissions]);

  const send = async () => {
    const text = draft.trim();
    if (!text || disabled || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  const pending = permissions.filter((item) => item.status === "PENDING");
  return (
    <div className="agent-chat" aria-label={"聊天 " + jobLabel}>
      <div className="agent-chat-body" ref={bodyRef} role="log">
        {messages.length === 0 ? (
          <div className="agent-chat-empty">还没有消息。</div>
        ) : (
          messages.map((message) => (
            <div
              key={message.sequence}
              className={"agent-chat-message agent-chat-message--" + message.kind}
            >
              {message.kind === "message" ? (
                <ChatMarkdown text={message.text} />
              ) : message.kind === "user" ? (
                <span className="agent-chat-user-text">{message.text}</span>
              ) : message.kind === "tool" ? (
                <details
                  className="agent-chat-tool"
                  open={message.tool?.status === "running" || Boolean(message.text)}
                >
                  <summary>
                    <span className="agent-chat-tool-title">{message.tool?.title ?? "命令执行"}</span>
                    <span className={`agent-chat-tool-status is-${message.tool?.status ?? ""}`}>
                      {toolStatusLabel(message.tool?.status)}
                    </span>
                  </summary>
                  {message.text ? <pre className="agent-chat-tool-output">{message.text}</pre> : null}
                </details>
              ) : (
                message.text
              )}
            </div>
          ))
        )}
        {pending.map((permission) => (
          <div key={permission.id} className="agent-permission-bar">
            <span>
              需要权限：{permission.permissionType} · {permission.target}
            </span>
            <button
              type="button"
              className="knowledge-button--primary"
              disabled={disabled}
              onClick={() => void onDecide(permission.id, "allow")}
            >
              允许
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={disabled}
              onClick={() => void onDecide(permission.id, "deny")}
            >
              拒绝
            </button>
          </div>
        ))}
      </div>
      {error ? <p className="knowledge-toast knowledge-toast--error">{error}</p> : null}
      <div className="agent-chat-input">
        <input
          type="text"
          aria-label="聊天输入"
          value={draft}
          disabled={disabled || sending}
          placeholder={disabled ? "会话已结束" : "输入消息…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
        />
        <button
          type="button"
          className="knowledge-button--primary"
          disabled={disabled || sending || !draft.trim()}
          onClick={() => void send()}
        >
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
