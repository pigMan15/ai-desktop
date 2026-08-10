# Run Agent Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Run Agent Job tabs with a compact responsive roster that gives every Job a stable English codename, Lucide icon, accent color, and visible status.

**Architecture:** Add a pure identity model next to the executor and derive identity entirely from `job.id`, avoiding Runtime contract changes. `RunAgentExecutor` renders the roster and existing terminal in a two-column shell; CSS collapses the roster to a horizontal strip on narrow viewports while preserving all existing callbacks and accessibility semantics.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Lucide React, native CSS.

---

### Task 1: Deterministic Agent Identity

**Files:**
- Create: `apps/renderer/src/features/runs/runAgentIdentity.ts`
- Create: `apps/renderer/src/features/runs/runAgentIdentity.test.ts`

- [ ] **Step 1: Write the failing identity tests**

```ts
import { describe, expect, it } from "vitest";
import { agentIdentity, agentIdentities } from "./runAgentIdentity";

describe("agentIdentity", () => {
  it("returns a stable codename, icon, and color for a Job", () => {
    expect(agentIdentity("job-running-codex")).toEqual(agentIdentity("job-running-codex"));
    expect(agentIdentity("job-running-codex")).toMatchObject({
      name: expect.any(String),
      icon: expect.any(String),
      color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });
  });

  it("adds stable suffixes when visible Jobs share a codename", () => {
    const jobIds = Array.from({ length: 40 }, (_, index) => `job-${index}`);
    const identities = agentIdentities(jobIds);
    expect(new Set(identities.map((identity) => identity.displayName)).size).toBe(40);
    expect(agentIdentities(jobIds)).toEqual(identities);
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/runAgentIdentity.test.ts
```

Expected: FAIL because `runAgentIdentity.ts` does not exist.

- [ ] **Step 3: Implement the pure identity model**

Create a fixed list of English codenames, icon keys, and accessible accent colors. Use a small deterministic string hash and expose:

```ts
export type AgentIconName = "gem" | "sparkles" | "hexagon" | "orbit";

export type AgentIdentity = {
  name: string;
  displayName: string;
  icon: AgentIconName;
  color: string;
};

export function agentIdentity(jobId: string): AgentIdentity;
export function agentIdentities(jobIds: string[]): AgentIdentity[];
```

`agentIdentities` counts duplicate base names in input order and appends ` 2`, ` 3`, and so on only when needed. It must not use `Math.random()`.

- [ ] **Step 4: Run the focused identity tests**

Expected: all identity tests PASS.

### Task 2: Agent Roster Markup and Behavior

**Files:**
- Modify: `apps/renderer/src/features/runs/RunAgentExecutor.tsx`
- Modify: `apps/renderer/src/features/runs/RunAgentExecutor.test.tsx`

- [ ] **Step 1: Update component tests first**

Add assertions that:

```ts
const roster = screen.getByRole("tablist", { name: "Agents" });
const runningAgent = within(roster).getByRole("tab", { name: /codex.*RUNNING.*job-running-codex/i });
expect(runningAgent).toHaveAttribute("aria-selected", "true");
expect(within(runningAgent).getByTestId("agent-codename")).not.toBeEmptyDOMElement();
expect(within(runningAgent).getByTestId("agent-icon")).toBeInTheDocument();
```

Keep the existing click assertion for `onSelectJob`, and assert terminal callbacks still target the selected Job.

- [ ] **Step 2: Run the executor tests and verify they fail on missing roster markup**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunAgentExecutor.test.tsx
```

Expected: FAIL because the current tab buttons do not expose the new roster structure.

- [ ] **Step 3: Implement the roster shell**

In `RunAgentExecutor.tsx`:

- import `Gem`, `Sparkles`, `Hexagon`, and `Orbit` from `lucide-react`;
- derive identities once for the visible `jobs` array;
- replace the current toolbar Job labels with a left roster;
- keep `role="tablist"`, `role="tab"`, `aria-selected`, and `onSelectJob`;
- set each item tooltip to its complete Job ID;
- keep the full-screen link in the selected executor header;
- retain the existing terminal, writable calculation, stop action, and status note.

Use a static icon lookup:

```ts
const AGENT_ICONS = {
  gem: Gem,
  sparkles: Sparkles,
  hexagon: Hexagon,
  orbit: Orbit,
} satisfies Record<AgentIconName, LucideIcon>;
```

Render the semantic item content as:

```tsx
<span className="run-agent-avatar" data-testid="agent-icon" style={{ "--agent-color": identity.color } as CSSProperties}>
  <Icon size={13} aria-hidden="true" />
</span>
<span className="run-agent-name" data-testid="agent-codename">{identity.displayName}</span>
<span className={`run-agent-status is-${candidate.status.toLowerCase()}`}>{candidate.status}</span>
```

- [ ] **Step 4: Run executor and Run detail component tests**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunAgentExecutor.test.tsx src/features/runs/RunDetailPage.test.tsx src/features/runs/RunAgentExecutorPage.test.tsx
```

Expected: all focused tests PASS, including Job switching and terminal callbacks.

### Task 3: Responsive Roster Styling

**Files:**
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Add the desktop two-column layout**

Add a stable executor grid with a `clamp(10rem, 16vw, 13rem)` roster column and `minmax(0, 1fr)` terminal column. The roster uses a dark-neutral surface compatible with existing tokens, a maximum height tied to the terminal surface, vertical overflow, and 4-6px item radii.

Selected items receive a subtle background and a 2px accent edge. Agent avatars remain 22px square and use `--agent-color`; names truncate with ellipsis; statuses remain right-aligned and never wrap.

- [ ] **Step 2: Add status and motion rules**

Style `RUNNING`, `COMPLETED`, `FAILED`, `QUEUED`, and `CANCELLED` distinctly using existing semantic tokens. Animate only the running indicator with opacity, and disable it with:

```css
@media (prefers-reduced-motion: reduce) {
  .run-agent-status.is-running::before { animation: none; }
}
```

- [ ] **Step 3: Add narrow viewport behavior**

Inside the existing mobile media query, switch the shell to one column and make the roster horizontal with `overflow-x: auto`. Set each Agent tab to a stable width so labels do not reflow the terminal.

- [ ] **Step 4: Run focused tests and production build**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunAgentExecutor.test.tsx src/features/runs/RunDetailPage.test.tsx src/features/runs/RunAgentExecutorPage.test.tsx
npm.cmd --workspace apps/renderer run build
```

Expected: tests PASS and Vite build exits with code 0. The existing chunk-size warning is acceptable.

### Task 4: Regression and Visual Verification

**Files:**
- Verify only; no planned source changes unless verification exposes a defect.

- [ ] **Step 1: Run the full Renderer suite**

```powershell
npm.cmd --workspace apps/renderer test
```

Expected: all Renderer test files PASS.

- [ ] **Step 2: Run whitespace validation**

```powershell
git diff --check -- apps/renderer/src/features/runs/runAgentIdentity.ts apps/renderer/src/features/runs/runAgentIdentity.test.ts apps/renderer/src/features/runs/RunAgentExecutor.tsx apps/renderer/src/features/runs/RunAgentExecutor.test.tsx apps/renderer/src/app/styles.css
```

Expected: exit code 0.

- [ ] **Step 3: Verify desktop and mobile rendering**

Start the existing Renderer development server and inspect the Run detail route at desktop and narrow widths. Confirm:

- every Job has one icon, codename, and visible status;
- selection changes the terminal without changing layout dimensions;
- long Agent lists scroll in the roster;
- mobile uses a horizontal roster without text overlap;
- terminal input and stop actions remain available only when allowed.

No Git staging, commit, or push is included because the current workspace contains existing uncommitted phase work.
