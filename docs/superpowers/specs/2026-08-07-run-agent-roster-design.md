# Run Agent Roster Design

## Goal

Replace the Run executor's dense Job tabs with a compact Agent roster inspired by the provided reference. Every started Job receives a stable visual identity made of an icon, an English codename, and its current status.

## Scope

- Change only the Run-owned Agent executor and its full-screen variant.
- Keep the existing terminal, input, interrupt, resize, stop, and Job switching behavior.
- Do not change Runtime contracts or persisted Job records.
- Do not change the standalone Terminal module.

## Identity Model

The renderer derives identity from `job.id` using a deterministic hash. The hash selects:

- one English codename from a fixed, collision-tolerant list;
- one icon from the existing Lucide icon package;
- one restrained accent color from a fixed accessible palette.

The same Job therefore keeps the same identity after refresh and navigation. The full Job ID remains available through the item tooltip and executor metadata. If two visible Jobs resolve to the same codename, append a stable numeric suffix derived from the hash.

## Layout

On desktop, the executor uses two columns:

- a narrow left roster containing the section label and Agent items;
- the existing terminal and selected Job controls on the right.

Each roster item is a button with a fixed-size colored icon, codename, and right-aligned status. The selected item uses a quiet surface highlight and accent edge. Running status has a restrained pulse indicator; terminal states are static.

The roster scrolls vertically when many Agents exist without resizing the terminal. On narrow viewports it moves above the terminal and becomes a horizontal scrolling list. The terminal keeps stable dimensions in both layouts.

## Status Presentation

- `QUEUED`: muted text and neutral indicator.
- `RUNNING`: emphasized text and animated status indicator.
- `COMPLETED`: success color, no animation.
- `FAILED`: danger color, no animation.
- `CANCELLED`: muted text, no animation.

Status remains visible text rather than color-only information. Motion is disabled under `prefers-reduced-motion`.

## Accessibility

- Preserve the existing `tablist` and `tab` semantics.
- Include codename, provider, status, and Job ID in accessible labeling or description.
- Keep keyboard focus visible and maintain a minimum practical click target.
- Do not rely on icon shape or color alone to communicate status.

## Testing

- Unit-test deterministic identity generation and collision suffixes.
- Update executor component tests to assert codenames, status text, selection, and callbacks.
- Verify desktop and narrow viewport layouts visually.
- Run the full Renderer test suite, production build, and `git diff --check`.
