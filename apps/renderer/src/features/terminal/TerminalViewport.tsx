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
  localEcho?: boolean;
  onInput?: (data: string) => Promise<void> | void;
  onResize?: (columns: number, rows: number) => void;
  onInterrupt?: () => void;
  className?: string;
  resetKey?: string;
};

export function TerminalViewport({
  ariaLabel,
  output,
  writable = false,
  localEcho = false,
  onInput,
  onResize,
  onInterrupt,
  className = "",
  resetKey,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const outputRef = useRef(output);
  const writableRef = useRef(writable);
  const localEchoRef = useRef(localEcho);
  const resetKeyRef = useRef(resetKey);
  const renderedSequenceRef = useRef(0);
  const newestSeenSequenceRef = useRef(0);
  const [followOutput, setFollowOutput] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [terminalReady, setTerminalReady] = useState(false);
  const [visibleOutput, setVisibleOutput] = useState(output);
  const outputText = useMemo(() => visibleOutput.map((event) => event.data).join(""), [visibleOutput]);

  function forwardInput(data: string) {
    if (!data || !writableRef.current) {
      return;
    }
    if (localEchoRef.current) {
      terminalRef.current?.write(localEchoData(data));
    }
    void onInputRef.current?.(data);
  }

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    outputRef.current = output;
  }, [output]);

  useEffect(() => {
    writableRef.current = writable;
    localEchoRef.current = localEcho;
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = !writable;
      terminalRef.current.options.cursorBlink = writable;
    }
  }, [localEcho, writable]);

  useEffect(() => {
    let disposed = false;
    let inputDisposable: { dispose(): void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([{ Terminal }, { FitAddon }, { SearchAddon }]) => {
      if (disposed || !containerRef.current) {
        return;
      }
      const terminal = new Terminal({
        // PTY output already contains the line endings and cursor controls emitted by the TUI.
        // Converting LF to CRLF here moves the cursor twice and produces drift/blank lines.
        convertEol: false,
        cursorBlink: writableRef.current,
        disableStdin: !writableRef.current,
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
      const fitTerminal = () => {
        fitAddon.fit();
        onResizeRef.current?.(terminal.cols, terminal.rows);
      };
      fitTerminal();
      resizeObserver = typeof window.ResizeObserver === "undefined"
        ? null
        : new window.ResizeObserver(fitTerminal);
      resizeObserver?.observe(containerRef.current);
      terminalRef.current = terminal;
      inputDisposable = terminal.onData(forwardInput);
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      for (const event of outputRef.current) {
        terminal.write(event.data);
        renderedSequenceRef.current = Math.max(renderedSequenceRef.current, event.sequence);
        newestSeenSequenceRef.current = Math.max(newestSeenSequenceRef.current, event.sequence);
      }
      setVisibleOutput(outputRef.current);
      setTerminalReady(true);
    });
    return () => {
      disposed = true;
      inputDisposable?.dispose();
      resizeObserver?.disconnect();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      renderedSequenceRef.current = 0;
      newestSeenSequenceRef.current = 0;
      setTerminalReady(false);
    };
  }, []);

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
    if (!terminalReady || resetKeyRef.current === resetKey) {
      return;
    }
    resetKeyRef.current = resetKey;
    terminalRef.current?.reset();
    fitAddonRef.current?.fit();
    if (terminalRef.current) {
      onResizeRef.current?.(terminalRef.current.cols, terminalRef.current.rows);
    }
    renderedSequenceRef.current = 0;
    newestSeenSequenceRef.current = 0;
    for (const event of output) {
      terminalRef.current?.write(event.data);
      renderedSequenceRef.current = Math.max(renderedSequenceRef.current, event.sequence);
      newestSeenSequenceRef.current = Math.max(newestSeenSequenceRef.current, event.sequence);
    }
    setVisibleOutput(output);
    setFollowOutput(true);
    setUnreadCount(0);
  }, [output, resetKey, terminalReady]);

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
          onPasteCapture={(event) => {
            const pastedText = event.clipboardData.getData("text");
            if (!pastedText || !writableRef.current) {
              return;
            }
            event.preventDefault();
            forwardInput(pastedText);
          }}
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

function localEchoData(data: string): string {
  if (data === "\r") {
    return "\r\n";
  }
  if (data === "\u007f") {
    return "\b \b";
  }
  if (data === "\u0003") {
    return "^C\r\n";
  }
  return data;
}
