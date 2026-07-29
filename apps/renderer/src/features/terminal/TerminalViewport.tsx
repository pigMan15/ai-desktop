import { useEffect, useMemo, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";

export type TerminalViewportOutput = {
  sequence: number;
  data: string;
};

export type TerminalViewportProps = {
  ariaLabel: string;
  output: TerminalViewportOutput[];
  writable?: boolean;
  onInput?: (data: string) => Promise<void> | void;
  onInterrupt?: () => void;
  className?: string;
};

export function TerminalViewport({
  ariaLabel,
  output,
  writable = false,
  onInput,
  onInterrupt,
  className = "",
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const onInputRef = useRef(onInput);
  const renderedSequenceRef = useRef(0);
  const newestSeenSequenceRef = useRef(0);
  const [followOutput, setFollowOutput] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [terminalReady, setTerminalReady] = useState(false);
  const [visibleOutput, setVisibleOutput] = useState(output);
  const outputText = useMemo(() => visibleOutput.map((event) => event.data).join(""), [visibleOutput]);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    let disposed = false;
    let inputDisposable: { dispose(): void } | null = null;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([{ Terminal }, { FitAddon }, { SearchAddon }]) => {
      if (disposed || !containerRef.current) {
        return;
      }
      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: writable,
        disableStdin: !writable,
        scrollback: 2_000,
        fontFamily: '"Cascadia Code", Consolas, monospace',
        fontSize: 13,
        theme: {
          background: "#111827",
          foreground: "#e5f7ef",
          cursor: "#fef3c7",
        },
      });
      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      inputDisposable = terminal.onData((data) => {
        if (writable) {
          void onInputRef.current?.(data);
        }
      });
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      for (const event of output) {
        terminal.write(event.data);
        renderedSequenceRef.current = Math.max(renderedSequenceRef.current, event.sequence);
        newestSeenSequenceRef.current = Math.max(newestSeenSequenceRef.current, event.sequence);
      }
      setVisibleOutput(output);
      setTerminalReady(true);
    });
    return () => {
      disposed = true;
      inputDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      renderedSequenceRef.current = 0;
      newestSeenSequenceRef.current = 0;
      setTerminalReady(false);
    };
  }, [writable]);

  useEffect(() => {
    if (!terminalReady) {
      return;
    }
    if (searchQuery.trim()) {
      searchAddonRef.current?.findNext(searchQuery, { caseSensitive: false });
    } else {
      searchAddonRef.current?.clearDecorations();
    }
  }, [searchQuery, terminalReady]);

  useEffect(() => {
    const newestSequence = output.reduce((latest, event) => Math.max(latest, event.sequence), 0);
    const newEvents = output.filter((event) => event.sequence > renderedSequenceRef.current);
    for (const event of newEvents) {
      terminalRef.current?.write(event.data);
      renderedSequenceRef.current = Math.max(renderedSequenceRef.current, event.sequence);
    }
    if (!followOutput && newestSequence > newestSeenSequenceRef.current) {
      setUnreadCount((current) => current + output.filter(
        (event) => event.sequence > newestSeenSequenceRef.current,
      ).length);
    } else {
      newestSeenSequenceRef.current = newestSequence;
      setUnreadCount(0);
    }
    setVisibleOutput(output);
  }, [followOutput, output]);

  function handleScroll() {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (element.scrollTop <= 0 && output.length > 0) {
      setFollowOutput(false);
      return;
    }
    const atBottom = distanceFromBottom <= 4;
    setFollowOutput(atBottom);
    if (atBottom) {
      newestSeenSequenceRef.current = output.reduce(
        (latest, event) => Math.max(latest, event.sequence),
        newestSeenSequenceRef.current,
      );
      setUnreadCount(0);
    }
  }

  function jumpToLatest() {
    const element = containerRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    newestSeenSequenceRef.current = output.reduce(
      (latest, event) => Math.max(latest, event.sequence),
      newestSeenSequenceRef.current,
    );
    setFollowOutput(true);
    setUnreadCount(0);
  }

  function updateSearchQuery(value: string) {
    setSearchQuery(value);
  }

  async function copyOutput() {
    if (outputText && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(outputText);
    }
  }

  function clearVisibleOutput() {
    terminalRef.current?.clear();
    setVisibleOutput([]);
  }

  return (
    <section className={`terminal-surface ${className}`.trim()}>
      <div className="terminal-toolbar">
        <label>
          搜索终端输出
          <input
            value={searchQuery}
            onChange={(event) => updateSearchQuery(event.target.value)}
            disabled={visibleOutput.length === 0}
          />
        </label>
        <button
          type="button"
          className="quiet-button"
          disabled={!searchQuery.trim()}
          onClick={() => searchAddonRef.current?.findPrevious(searchQuery, { caseSensitive: false })}
        >
          上一个匹配
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={!searchQuery.trim()}
          onClick={() => searchAddonRef.current?.findNext(searchQuery, { caseSensitive: false })}
        >
          下一个匹配
        </button>
        <button type="button" className="quiet-button" disabled={!outputText} onClick={copyOutput}>
          复制输出
        </button>
        <button type="button" className="quiet-button" disabled={!outputText} onClick={clearVisibleOutput}>
          清屏
        </button>
        <button type="button" className="quiet-button" disabled={!writable} onClick={onInterrupt}>
          中断
        </button>
      </div>
      <div className="terminal-viewport-wrap">
        <div
          ref={containerRef}
          className="terminal-viewport"
          aria-label={ariaLabel}
          tabIndex={0}
          onMouseDownCapture={() => terminalRef.current?.focus()}
          onClick={() => terminalRef.current?.focus()}
          onScroll={handleScroll}
        />
        {unreadCount > 0 ? (
          <button type="button" className="terminal-jump-latest" onClick={jumpToLatest}>
            跳到最新（{unreadCount} 条未读）
          </button>
        ) : null}
      </div>
      <pre className="terminal-screen-reader-output" aria-label={`${ariaLabel}文本`} aria-hidden="false">
        {outputText}
      </pre>
    </section>
  );
}
