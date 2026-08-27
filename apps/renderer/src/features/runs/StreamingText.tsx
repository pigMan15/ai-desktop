import { useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown";

const FRAME_MS = 16;
const MAX_FRAMES = 220; // 约 3.5s 最多逐字曝光

type Props = {
  text: string;
  animate: boolean;
};

/**
 * 渐进式展示助手消息：新消息按字符逐步曝光，
 * 完成后切换为 Markdown 渲染；历史消息直接显示完整内容。
 */
export function StreamingText({ text, animate }: Props) {
  const [visible, setVisible] = useState(animate ? 0 : text.length);
  const textRef = useRef(text);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    textRef.current = text;
    if (!animate) {
      setVisible(text.length);
      return;
    }
    // 流式输出时消息文本会持续增长，保持已曝光位置不回退
    setVisible((prev) => Math.min(prev, text.length));
  }, [text, animate]);

  useEffect(() => {
    if (!animate) return;
    const target = textRef.current.length;
    if (visible >= target) return;
    const step = Math.max(1, Math.ceil(target / MAX_FRAMES));
    timerRef.current = window.setInterval(() => {
      setVisible((prev) => {
        const next = Math.min(prev + step, textRef.current.length);
        if (next >= textRef.current.length && timerRef.current !== null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return next;
      });
    }, FRAME_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [animate, visible, text]);

  const revealed = !animate || visible >= text.length;
  if (revealed) {
    return <ChatMarkdown text={text} />;
  }
  return (
    <span className="agent-chat-streaming">
      {text.slice(0, visible)}
      <span className="agent-chat-cursor" aria-hidden="true" />
    </span>
  );
}
