import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalViewport } from "./TerminalViewport";

const terminalWrites: string[] = [];
let terminalDataHandler: ((data: string) => void) | null = null;
const findNext = vi.fn();
const findPrevious = vi.fn();
const clearDecorations = vi.fn();
const fit = vi.fn();
const focus = vi.fn();
const reset = vi.fn();
let terminalOptions: Record<string, unknown> | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    options = {};
    constructor(options: Record<string, unknown>) {
      terminalOptions = options;
    }
    loadAddon() {}
    open() {}
    write(data: string) {
      terminalWrites.push(data);
    }
    clear() {
      terminalWrites.length = 0;
    }
    reset() {
      reset();
      terminalWrites.length = 0;
    }
    focus = focus;
    dispose() {}
    onData(handler: (data: string) => void) {
      terminalDataHandler = handler;
      return { dispose() {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FakeFitAddon {
    fit = fit;
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class FakeSearchAddon {
    findNext = findNext;
    findPrevious = findPrevious;
    clearDecorations = clearDecorations;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  terminalWrites.length = 0;
  terminalDataHandler = null;
  terminalOptions = null;
});

describe("TerminalViewport", () => {
  it("preserves PTY line endings so terminal cursor positioning remains stable", async () => {
    render(<TerminalViewport ariaLabel="ANSI terminal" output={[]} />);

    await waitFor(() => expect(terminalOptions).not.toBeNull());
    expect(terminalOptions?.convertEol).toBe(false);
  });

  it("writes output to xterm and sends direct user input", async () => {
    const onInput = vi.fn();
    render(
      <TerminalViewport
        ariaLabel="Agent 交互终端"
        output={[{ sequence: 1, data: "第一行\r\n" }]}
        writable
        onInput={onInput}
      />,
    );

    await waitFor(() => expect(terminalWrites).toEqual(["第一行\r\n"]));
    terminalDataHandler?.("继续执行\r");

    expect(onInput).toHaveBeenCalledWith("继续执行\r");
    expect(screen.getByLabelText("Agent 交互终端")).toHaveClass("terminal-viewport");
    expect(screen.getByText("第一行")).toBeInTheDocument();
  });

  it("locally echoes governed shell input while forwarding it to the handler", async () => {
    const onInput = vi.fn();
    render(
      <TerminalViewport
        ariaLabel="ANSI 终端"
        output={[]}
        writable
        localEcho
        onInput={onInput}
      />,
    );

    await waitFor(() => expect(fit).toHaveBeenCalled());
    terminalDataHandler?.("echo hello");

    expect(terminalWrites.at(-1)).toBe("echo hello");
    expect(onInput).toHaveBeenCalledWith("echo hello");
  });

  it("forwards clipboard paste from the terminal surface", async () => {
    const onInput = vi.fn();
    render(
      <TerminalViewport
        ariaLabel="ANSI 终端"
        output={[]}
        writable
        localEcho
        onInput={onInput}
      />,
    );

    await waitFor(() => expect(fit).toHaveBeenCalled());
    fireEvent.paste(screen.getByLabelText("ANSI 终端", { exact: true }), {
      clipboardData: { getData: () => "npm test\r" },
    });

    expect(onInput).toHaveBeenCalledWith("npm test\r");
    expect(terminalWrites.at(-1)).toBe("npm test\r");
  });

  it("focuses xterm before interactive viewport click handlers run", async () => {
    render(<TerminalViewport ariaLabel="ANSI 终端" output={[]} writable />);

    await waitFor(() => expect(fit).toHaveBeenCalled());
    fireEvent.mouseDown(screen.getByLabelText("ANSI 终端", { exact: true }));

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("enables direct input when a previously read-only viewport becomes writable", async () => {
    const initialInput = vi.fn();
    const interactiveInput = vi.fn();
    const { rerender } = render(
      <TerminalViewport ariaLabel="ANSI 终端" output={[]} onInput={initialInput} />,
    );

    await waitFor(() => expect(fit).toHaveBeenCalled());
    rerender(
      <TerminalViewport ariaLabel="ANSI 终端" output={[]} writable onInput={interactiveInput} />,
    );
    await waitFor(() => expect(fit).toHaveBeenCalledTimes(1));
    terminalDataHandler?.("del .\\build\r");

    expect(interactiveInput).toHaveBeenCalledWith("del .\\build\r");
    expect(initialInput).not.toHaveBeenCalled();
  });

  it("keeps the terminal buffer when writable state changes", async () => {
    const { rerender } = render(
      <TerminalViewport
        ariaLabel="Agent 交互终端"
        output={[{ sequence: 1, data: "\u001b[2J当前界面\r\n" }]}
        writable
      />,
    );

    await waitFor(() => expect(terminalWrites).toEqual(["\u001b[2J当前界面\r\n"]));
    rerender(
      <TerminalViewport
        ariaLabel="Agent 交互终端"
        output={[{ sequence: 1, data: "\u001b[2J当前界面\r\n" }]}
      />,
    );

    await waitFor(() => expect(fit).toHaveBeenCalledTimes(1));
    expect(terminalWrites).toEqual(["\u001b[2J当前界面\r\n"]);
  });

  it("resets the xterm screen when the output session changes", async () => {
    const { rerender } = render(
      <TerminalViewport
        ariaLabel="Agent 交互终端"
        resetKey="run-old:agent-old"
        output={[{ sequence: 1, data: "旧 Run 输出\r\n" }]}
        writable
      />,
    );

    await waitFor(() => expect(terminalWrites).toEqual(["旧 Run 输出\r\n"]));
    rerender(
      <TerminalViewport
        ariaLabel="Agent 交互终端"
        resetKey="run-empty:none"
        output={[]}
      />,
    );

    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(fit).toHaveBeenCalledTimes(2);
    expect(terminalWrites).toEqual([]);
  });

  it("pauses follow mode after user scrolls up and shows unread output", async () => {
    const { rerender } = render(
      <TerminalViewport
        ariaLabel="交互日志"
        output={[{ sequence: 1, data: "第一行\r\n" }]}
        writable
      />,
    );
    await waitFor(() => expect(terminalWrites).toEqual(["第一行\r\n"]));

    fireEvent.scroll(screen.getByLabelText("交互日志"), { target: { scrollTop: 0 } });
    rerender(
      <TerminalViewport
        ariaLabel="交互日志"
        output={[
          { sequence: 1, data: "第一行\r\n" },
          { sequence: 2, data: "第二行\r\n" },
        ]}
        writable
      />,
    );

    expect(await screen.findByRole("button", { name: "跳到最新（1 条未读）" })).toBeVisible();
  });

  it("searches, copies, clears, and interrupts from the viewport toolbar", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onInterrupt = vi.fn();
    render(
      <TerminalViewport
        ariaLabel="ANSI 终端"
        output={[{ sequence: 1, data: "build completed\r\n" }]}
        writable
        onInterrupt={onInterrupt}
      />,
    );

    fireEvent.change(screen.getByLabelText("搜索终端输出"), { target: { value: "build" } });
    await waitFor(() => expect(findNext).toHaveBeenCalledWith("build", { caseSensitive: false }));
    fireEvent.click(screen.getByRole("button", { name: "上一个匹配" }));
    expect(findPrevious).toHaveBeenCalledWith("build", { caseSensitive: false });
    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("build completed\r\n"));
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(onInterrupt).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清屏" }));
    expect(screen.queryByText("build completed")).not.toBeInTheDocument();
  });
});
