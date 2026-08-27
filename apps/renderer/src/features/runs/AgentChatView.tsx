import { useEffect, useRef, useState } from "react";
import { Bot, Terminal, User } from "lucide-react";
import type { AgentPermissionRequest } from "@workflow-platform/contracts";
import type { AgentChatMessage } from "./runAgentExecutorModel";
import { ChatMarkdown } from "./ChatMarkdown";
import { StreamingText } from "./StreamingText";

const toolStatusLabel = (status: string | undefined): string => {
  if (status === "running") return "执行中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return status || "执行";
};

const formatTime = (value?: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
};

type Props = {
  jobLabel: string;
  messages: AgentChatMessage[];
  permissions: AgentPermissionRequest[];
  disabled: boolean;
  permissionDisabled?: boolean;
  onSend(message: string): Promise<void> | void;
  onDecide(requestId: string, decision: "allow" | "deny", reason?: string): Promise<void> | void;
};

export function AgentChatView({ jobLabel, messages, permissions, disabled, permissionDisabled = false, onSend, onDecide }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const streamInitializedRef = useRef(false);
  const streamInitialMaxRef = useRef(0);
  if (!streamInitializedRef.current && messages.length > 0) {
    streamInitializedRef.current = true;
    streamInitialMaxRef.current = messages.reduce((max, message) => Math.max(max, message.sequence), 0);
  }

  // 仅当接近底部时自动滚到最新消息，用户向上滚动回顾时不强行拽回。
  useEffect(() => {
    const element = bodyRef.current;
    if (element && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, permissions]);

  const handleScroll = () => {
    const element = bodyRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

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
      <div className="agent-chat-body" ref={bodyRef} role="log" onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="agent-chat-empty">还没有消息。</div>
        ) : (
          messages.map((message) => {
            if (message.kind === "permission" || message.kind === "turn") {
              return (
                <div key={message.sequence} className={"agent-chat-row agent-chat-row--" + message.kind}>
                  <div className={"agent-chat-message agent-chat-message--" + message.kind}>{message.text}</div>
                </div>
              );
            }
            const isUser = message.kind === "user";
            const avatarClass = isUser
              ? "agent-chat-avatar--user"
              : message.kind === "tool"
                ? "agent-chat-avatar--tool"
                : "agent-chat-avatar--assistant";
            const avatarIcon = isUser ? (
              <User size={14} aria-hidden="true" />
            ) : message.kind === "tool" ? (
              <Terminal size={14} aria-hidden="true" />
            ) : (
              <Bot size={14} aria-hidden="true" />
            );
            return (
              <div key={message.sequence} className={"agent-chat-row agent-chat-row--" + message.kind}>
                {!isUser ? <span className={"agent-chat-avatar " + avatarClass} aria-hidden="true">{avatarIcon}</span> : null}
                <div className="agent-chat-column">
                  <div className={"agent-chat-message agent-chat-message--" + message.kind}>
                    {message.kind === "message" ? (
                      <StreamingText
                        text={message.text}
                        animate={message.sequence > streamInitialMaxRef.current}
                      />
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
                  {message.createdAt ? <span className="agent-chat-time">{formatTime(message.createdAt)}</span> : null}
                </div>
                {isUser ? <span className={"agent-chat-avatar " + avatarClass} aria-hidden="true">{avatarIcon}</span> : null}
              </div>
            );
          })
        )}
        {pending.map((permission) => (
          <div key={permission.id} className="agent-permission-bar">
            <span>
              需要权限：{permission.permissionType} · {permission.target}
            </span>
            <button
              type="button"
              className="knowledge-button--primary"
              disabled={permissionDisabled}
              onClick={() => void onDecide(permission.id, "allow")}
            >
              允许
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={permissionDisabled}
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
