import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StreamingText } from "./StreamingText";

describe("StreamingText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders full text immediately when animation is disabled", () => {
    render(<StreamingText text="hello **world**" animate={false} />);
    expect(screen.getByText("world").tagName).toBe("STRONG");
  });

  it("reveals text progressively with a cursor when animation is enabled", () => {
    render(<StreamingText text="hello world" animate={true} />);
    expect(screen.queryByText(/hello world/)).not.toBeInTheDocument();
    expect(document.querySelector(".agent-chat-cursor")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(document.querySelector(".agent-chat-cursor")).toBeNull();
  });

  it("keeps reveal position when streamed text grows", () => {
    const { rerender } = render(<StreamingText text="hello" animate={true} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender(<StreamingText text="hello world" animate={true} />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(document.querySelector(".agent-chat-cursor")).toBeNull();
  });
});
