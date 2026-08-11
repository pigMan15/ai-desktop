import { Fragment, type ReactNode } from "react";

type InlineToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "link"; text: string; url: string };

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: "text", value: text.slice(cursor, index) });
    }
    const [raw, code, bold, italic, link] = match;
    if (code) tokens.push({ type: "code", value: code.slice(1, -1) });
    else if (bold) tokens.push({ type: "bold", value: bold.slice(2, -2) });
    else if (italic) tokens.push({ type: "italic", value: italic.slice(1, -1) });
    else if (link) {
      const matchLink = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(link);
      tokens.push({
        type: "link",
        text: matchLink ? matchLink[1] : link,
        url: matchLink ? matchLink[2] : link,
      });
    } else if (raw) {
      tokens.push({ type: "text", value: raw });
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) {
    tokens.push({ type: "text", value: text.slice(cursor) });
  }
  return tokens;
}

function renderInline(text: string): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    if (token.type === "code") {
      return <code key={index}>{token.value}</code>;
    }
    if (token.type === "bold") {
      return <strong key={index}>{renderInline(token.value)}</strong>;
    }
    if (token.type === "italic") {
      return <em key={index}>{renderInline(token.value)}</em>;
    }
    if (token.type === "link") {
      return (
        <a key={index} href={token.url} target="_blank" rel="noreferrer">
          {token.text}
        </a>
      );
    }
    return <Fragment key={index}>{token.value}</Fragment>;
  });
}

export function ChatMarkdown({ text }: { text: string }) {
  const parts = text.split(/```[^`\n]*\n?([\s\S]*?)```/);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          return (
            <pre key={index} className="chat-markdown-code">
              <code>{part.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        if (!part) return null;
        return <span key={index}>{renderInline(part)}</span>;
      })}
    </>
  );
}
