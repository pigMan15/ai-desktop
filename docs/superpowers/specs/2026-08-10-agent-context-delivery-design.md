# Agent Context Delivery Design

## Goal

Allow downstream Agents to read upstream artifacts from their Run workspace by path instead of receiving full file contents in the startup prompt. Keep summary delivery available for compatibility and small workflows.

## Design

`AgentContextSpec.delivery` supports `path`, `hybrid`, and `summary`. The default for newly created or legacy configurations is `path`. Runtime always validates artifact URIs against the Run execution workspace and emits relative POSIX paths, content hashes, source node IDs, and artifact types. `path` emits no file body; `hybrid` emits a bounded summary using the existing limits; `summary` preserves the current bounded behavior.

The generated prompt tells the Agent that paths are readable from its current Run workspace, that upstream artifacts are inputs and must not be modified, and that it should read only the files needed for the task. Missing files and unsafe paths fail context construction before the Agent starts. Existing API fields remain compatible; `summary` becomes optional in renderer-facing types.

The workflow editor exposes the delivery mode and only enables summary limits for modes that use summaries. No artifact storage, provider command, terminal transport, or remote URL behavior changes.

## Verification

Runtime tests cover each delivery mode, workspace path safety, and legacy defaults. Contract/compiler tests cover serialization and validation. Renderer tests cover editing and displaying the new setting. Full package tests and production build are required.
