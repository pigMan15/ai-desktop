# Full Feature Local Delivery Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and document a validated local-staging workflow that exercises every workflow node kind and all Run support modules.

**Architecture:** A runtime package module owns the canonical example definition. A small command-line installer resolves immutable role versions, validates and creates the workflow through `WorkflowRuntimeService`, then binds it to the selected project. A Chinese guide walks through one complete Run.

**Tech Stack:** Python 3, Pydantic workflow models, SQLite repositories, pytest, Markdown.

---

### Task 1: Canonical workflow definition

**Files:**
- Create: `runtime/src/workflow_platform/examples/full_feature_workflow.py`
- Test: `runtime/tests/test_full_feature_workflow.py`

- [ ] Add a test asserting all node kinds, a linear graph, local-staging deployment metadata, role bindings, artifact declarations and zero compiler diagnostics.
- [ ] Run `python -m pytest runtime/tests/test_full_feature_workflow.py -q` and confirm it fails because the builder is missing.
- [ ] Implement `build_full_feature_workflow(role_versions)` with the 13-node canonical definition.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Idempotent installer

**Files:**
- Create: `scripts/install_full_feature_workflow.py`

- [ ] Parse `--db` and `--project-id`, defaulting to `.workflow-platform/runtime.db` and the confirmed demo project.
- [ ] Resolve required active role asset versions and compile the generated definition.
- [ ] Create the workflow through `WorkflowRuntimeService` if absent; otherwise reuse its current version.
- [ ] Bind the workflow version to the target project and print the previous and resulting bindings.
- [ ] Execute the installer against the active database and verify the inserted rows using a read-only query.

### Task 3: Guided use case

**Files:**
- Create: `docs/full-feature-local-delivery-workflow-guide.zh-CN.md`

- [ ] Document prerequisites and Run creation values.
- [ ] Provide an explicit operation sequence for every workflow node.
- [ ] Include terminal, artifacts, approvals, gates, deployment, audit, recovery and knowledge-base checks.
- [ ] Document expected completion signals and safe cleanup.

### Task 4: Final verification

- [ ] Run the focused workflow test.
- [ ] Run the installer a second time and verify idempotency.
- [ ] Query the target binding and compiled definition counts.
- [ ] Run `git diff --check` for the new files.
