import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

/**
 * Full Markdown renderer for assistant chat bubbles.
 *
 * - react-markdown: CommonMark; raw HTML is escaped and shown as literal text
 * - remark-gfm: tables, task lists, strikethrough, autolinks
 * - rehype-highlight: code block highlighting (highlight.js github-dark)
 *
 * Links open in a new tab; all other elements use the default rendering and
 * are styled through the .chat-markdown container in styles.css.
 */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
