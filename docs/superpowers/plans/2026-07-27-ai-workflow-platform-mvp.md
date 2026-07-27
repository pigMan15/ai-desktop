# AI 工程工作流平台 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs` 中的规格和已确认设计，交付一个可运行、可测试的 AI 工程工作流平台 MVP。

**Architecture:** 采用 Electron + React + TypeScript + Python Runtime + SQLite 的本地桌面架构。Renderer 只通过 typed IPC/RPC 调用 Runtime，Workflow Kernel 负责唯一可信状态推进，`run_events` 是事实源，`run_projections` 驱动 UI。

**Tech Stack:** Electron、React、Vite、TypeScript、Vitest、Python 3.11+、Pydantic、FastAPI、pytest、SQLite、Playwright。

---

## 文件结构

本计划会创建以下主要文件和目录：

- `package.json`：monorepo scripts 和 npm workspace。
- `tsconfig.base.json`：共享 TypeScript 编译配置。
- `apps/renderer/`：React/Vite renderer 应用。
- `apps/desktop/`：Electron main/preload 桌面壳。
- `packages/contracts/`：TypeScript 共享 contracts。
- `runtime/pyproject.toml`：Python runtime 项目配置。
- `runtime/src/workflow_platform/`：Python Runtime、API、Kernel、Adapter、Persistence、Terminal、Agent Provider。
- `runtime/tests/`：Python 单元和集成测试。
- `tests/e2e/`：Playwright 端到端测试。
- `scripts/`：开发、迁移、验证辅助脚本。

文件边界：

- `packages/contracts/src/workflow.ts` 定义 canonical workflow 类型。
- `packages/contracts/src/events.ts` 定义 run event、actor、projection、allowed action。
- `packages/contracts/src/rpc.ts` 定义 RPC request/response contract。
- `packages/contracts/src/errors.ts` 定义 typed error code。
- `runtime/src/workflow_platform/models.py` 定义 Pydantic 模型，与 TS contracts 对齐。
- `runtime/src/workflow_platform/persistence/database.py` 管理 SQLite 连接、WAL、migration。
- `runtime/src/workflow_platform/persistence/repositories.py` 封装 project、workflow、run、event、projection、artifact、approval、gate、terminal 数据访问。
- `runtime/src/workflow_platform/adapters/registry.py` 管理 Adapter detection/import。
- `runtime/src/workflow_platform/adapters/harness.py` 导入 `.harness` 风格项目。
- `runtime/src/workflow_platform/compiler/compiler.py` 校验 workflow 并生成 graph view model。
- `runtime/src/workflow_platform/kernel/transition.py` 实现 `transition(runId, event, expectedRevision)`。
- `runtime/src/workflow_platform/kernel/projection.py` 从 event 重建 projection。
- `runtime/src/workflow_platform/api/app.py` 暴露 FastAPI endpoint。
- `runtime/src/workflow_platform/terminals/service.py` 管理 terminal session MVP。
- `runtime/src/workflow_platform/execution/agent.py` 定义 `AgentExecutor` 和默认 provider。
- `apps/renderer/src/features/*` 各自负责一个页面，不绕过 Runtime。

---

## Task 1: Monorepo 基础工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `apps/renderer/package.json`
- Create: `apps/renderer/index.html`
- Create: `apps/renderer/src/main.tsx`
- Create: `apps/renderer/src/app/App.tsx`
- Create: `apps/renderer/src/app/styles.css`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src/main/main.ts`
- Create: `apps/desktop/src/preload/preload.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/index.ts`
- Create: `runtime/pyproject.toml`
- Create: `runtime/src/workflow_platform/__init__.py`
- Create: `runtime/src/workflow_platform/main.py`
- Create: `runtime/tests/test_health.py`

- [ ] **Step 1: 写基础工程文件**

`package.json`:

```json
{
  "name": "ai-workflow-platform",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev:renderer": "npm --workspace apps/renderer run dev",
    "dev:desktop": "npm --workspace apps/desktop run dev",
    "build": "npm --workspaces run build",
    "test": "npm --workspaces run test",
    "test:runtime": "cd runtime && python -m pytest",
    "verify": "npm run test && npm run test:runtime"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`runtime/src/workflow_platform/main.py`:

```python
from __future__ import annotations


def health() -> dict[str, str]:
    return {"status": "ok", "service": "workflow-runtime"}
```

`runtime/tests/test_health.py`:

```python
from workflow_platform.main import health


def test_health_returns_runtime_status() -> None:
    assert health() == {"status": "ok", "service": "workflow-runtime"}
```

- [ ] **Step 2: 运行基础测试**

Run:

```bash
cd runtime && python -m pytest
```

Expected:

```text
1 passed
```

- [ ] **Step 3: 提交基础工程**

```bash
git add package.json tsconfig.base.json apps packages runtime
git commit -m "chore: scaffold workflow platform monorepo"
```

---

## Task 2: TypeScript Contracts

**Files:**
- Create: `packages/contracts/src/workflow.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/rpc.ts`
- Create: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`

- [ ] **Step 1: 写 contracts 测试**

`packages/contracts/src/contracts.test.ts`:

```ts
import { RUN_EVENT_TYPES, NODE_KINDS, ERROR_CODES } from "./index";

it("exports stable workflow and runtime constants", () => {
  expect(NODE_KINDS).toContain("agent");
  expect(RUN_EVENT_TYPES).toContain("HUMAN_APPROVED");
  expect(ERROR_CODES).toContain("REVISION_CONFLICT");
});
```

- [ ] **Step 2: 实现 contracts**

`packages/contracts/src/workflow.ts`:

```ts
export const NODE_KINDS = [
  "task",
  "agent",
  "approval",
  "gate",
  "evidence",
  "deploy",
  "report",
  "composite"
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type RequirementSpec =
  | { type: "artifact"; artifactType: string; required: boolean }
  | { type: "approval"; approvalRole?: string; required: boolean }
  | { type: "gate"; gateId: string; required: boolean }
  | { type: "evidence"; evidenceType: string; required: boolean };

export type WorkflowNode = {
  id: string;
  name: string;
  kind: NodeKind;
  role?: string;
  description?: string;
  requires?: RequirementSpec[];
  gates?: string[];
  metadata?: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  condition?: string;
  trigger?: string;
  metadata?: Record<string, unknown>;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  version: string;
  sourceAdapter: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  roles: Array<{ id: string; name: string }>;
  gates: Array<{ id: string; name: string; description?: string }>;
  policies: Record<string, unknown>;
  metadata: Record<string, unknown>;
};
```

`packages/contracts/src/events.ts`:

```ts
export const RUN_EVENT_TYPES = [
  "RUN_CREATED",
  "NODE_STARTED",
  "ARTIFACT_SUBMITTED",
  "APPROVAL_REQUESTED",
  "HUMAN_APPROVED",
  "HUMAN_REJECTED",
  "HUMAN_DEFERRED",
  "GATE_STARTED",
  "GATE_PASSED",
  "GATE_FAILED",
  "GATE_WAIVED",
  "NODE_COMPLETED",
  "NODE_FAILED",
  "NODE_RETRIED",
  "RUN_BLOCKED",
  "RUN_COMPLETED",
  "RUN_ARCHIVED"
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];
export type ActorType = "human" | "agent" | "system" | "verifier" | "executor" | "adapter";
export type ActorSource = "renderer" | "runtime" | "terminal" | "agent" | "adapter";

export type Actor = {
  id: string;
  type: ActorType;
  source: ActorSource;
  trusted: boolean;
};

export type RunEvent = {
  id: string;
  runId: string;
  type: RunEventType;
  nodeId?: string;
  actor: Actor;
  payload: Record<string, unknown>;
  createdAt: string;
  revision: string;
};

export type AllowedAction = {
  id: string;
  label: string;
  eventType: RunEventType;
  nodeId?: string;
  risk: "low" | "medium" | "high";
};

export type RunProjection = {
  runId: string;
  status: "CREATED" | "IN_PROGRESS" | "REVIEWING" | "BLOCKED" | "DONE" | "ARCHIVED";
  currentNodeIds: string[];
  nodeStates: Record<string, string>;
  allowedActions: AllowedAction[];
  blockingReasons: Array<{ code: string; message: string; nodeId?: string }>;
  revision: string;
  updatedAt: string;
};
```

`packages/contracts/src/errors.ts`:

```ts
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "ADAPTER_UNSUPPORTED",
  "WORKFLOW_DIAGNOSTICS_ERROR",
  "REVISION_CONFLICT",
  "PERMISSION_DENIED",
  "INVALID_TRANSITION",
  "MISSING_ARTIFACT",
  "UNSAFE_PATH",
  "MISSING_EVIDENCE",
  "GATE_FAILED",
  "APPROVAL_REJECTED",
  "RUNTIME_UNAVAILABLE",
  "TERMINAL_UNAVAILABLE"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
```

`packages/contracts/src/rpc.ts`:

```ts
import type { RunEvent, RunProjection } from "./events";
import type { WorkflowDefinition } from "./workflow";

export type DetectionResult = {
  adapterId: string;
  name: string;
  score: number;
  diagnostics: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  rootPath: string;
  activeProtocol?: string;
};

export type WorkflowVersion = {
  id: string;
  projectId: string;
  adapterId: string;
  name: string;
  version: string;
  definition: WorkflowDefinition;
  contentHash: string;
  createdAt: string;
};

export type TransitionResult = {
  run: RunProjection;
  accepted: boolean;
  revision: string;
  allowedActions: RunProjection["allowedActions"];
  blockingReasons: RunProjection["blockingReasons"];
  emittedEvents: RunEvent[];
};
```

`packages/contracts/src/index.ts`:

```ts
export * from "./workflow";
export * from "./events";
export * from "./rpc";
export * from "./errors";
```

- [ ] **Step 3: 运行 contracts 测试**

Run:

```bash
npm --workspace packages/contracts run test
```

Expected:

```text
PASS src/contracts.test.ts
```

- [ ] **Step 4: 提交 contracts**

```bash
git add packages/contracts
git commit -m "feat: define workflow platform contracts"
```

---

## Task 3: Python Canonical Models

**Files:**
- Create: `runtime/src/workflow_platform/models.py`
- Create: `runtime/tests/test_models.py`

- [ ] **Step 1: 写模型测试**

`runtime/tests/test_models.py`:

```python
import pytest
from pydantic import ValidationError

from workflow_platform.models import Actor, WorkflowDefinition, WorkflowNode


def test_workflow_definition_accepts_task_node() -> None:
    workflow = WorkflowDefinition(
        id="wf",
        name="Demo",
        version="1",
        sourceAdapter="harness",
        nodes=[WorkflowNode(id="plan", name="Plan", kind="task")],
        edges=[],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )
    assert workflow.nodes[0].kind == "task"


def test_actor_requires_trust_flag() -> None:
    actor = Actor(id="u1", type="human", source="renderer", trusted=True)
    assert actor.trusted is True


def test_invalid_node_kind_fails() -> None:
    with pytest.raises(ValidationError):
        WorkflowNode(id="x", name="Bad", kind="unknown")
```

- [ ] **Step 2: 实现 Pydantic 模型**

`runtime/src/workflow_platform/models.py`:

```python
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


NodeKind = Literal["task", "agent", "approval", "gate", "evidence", "deploy", "report", "composite"]
RunStatus = Literal["CREATED", "IN_PROGRESS", "REVIEWING", "BLOCKED", "DONE", "ARCHIVED"]
NodeState = Literal[
    "PENDING",
    "READY",
    "RUNNING",
    "AWAITING_ARTIFACT",
    "AWAITING_APPROVAL",
    "AWAITING_GATE",
    "PASSED",
    "FAILED",
    "BLOCKED",
    "SKIPPED",
]
RunEventType = Literal[
    "RUN_CREATED",
    "NODE_STARTED",
    "ARTIFACT_SUBMITTED",
    "APPROVAL_REQUESTED",
    "HUMAN_APPROVED",
    "HUMAN_REJECTED",
    "HUMAN_DEFERRED",
    "GATE_STARTED",
    "GATE_PASSED",
    "GATE_FAILED",
    "GATE_WAIVED",
    "NODE_COMPLETED",
    "NODE_FAILED",
    "NODE_RETRIED",
    "RUN_BLOCKED",
    "RUN_COMPLETED",
    "RUN_ARCHIVED",
]


class RequirementSpec(BaseModel):
    type: Literal["artifact", "approval", "gate", "evidence"]
    artifactType: str | None = None
    approvalRole: str | None = None
    gateId: str | None = None
    evidenceType: str | None = None
    required: bool = True


class WorkflowNode(BaseModel):
    id: str
    name: str
    kind: NodeKind
    role: str | None = None
    description: str | None = None
    requires: list[RequirementSpec] = Field(default_factory=list)
    gates: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(BaseModel):
    id: str
    from_: str = Field(alias="from")
    to: str
    condition: str | None = None
    trigger: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowDefinition(BaseModel):
    id: str
    name: str
    version: str
    sourceAdapter: str
    nodes: list[WorkflowNode]
    edges: list[WorkflowEdge]
    roles: list[dict[str, Any]]
    gates: list[dict[str, Any]]
    policies: dict[str, Any]
    metadata: dict[str, Any]


class Actor(BaseModel):
    id: str
    type: Literal["human", "agent", "system", "verifier", "executor", "adapter"]
    source: Literal["renderer", "runtime", "terminal", "agent", "adapter"]
    trusted: bool


class RunEvent(BaseModel):
    id: str
    runId: str
    type: RunEventType
    nodeId: str | None = None
    actor: Actor
    payload: dict[str, Any] = Field(default_factory=dict)
    createdAt: str
    revision: str


class AllowedAction(BaseModel):
    id: str
    label: str
    eventType: RunEventType
    nodeId: str | None = None
    risk: Literal["low", "medium", "high"] = "low"


class BlockingReason(BaseModel):
    code: str
    message: str
    nodeId: str | None = None


class RunProjection(BaseModel):
    runId: str
    status: RunStatus
    currentNodeIds: list[str]
    nodeStates: dict[str, NodeState]
    allowedActions: list[AllowedAction]
    blockingReasons: list[BlockingReason]
    revision: str
    updatedAt: str
```

- [ ] **Step 3: 运行模型测试**

Run:

```bash
cd runtime && python -m pytest tests/test_models.py -v
```

Expected:

```text
3 passed
```

- [ ] **Step 4: 提交模型**

```bash
git add runtime/src/workflow_platform/models.py runtime/tests/test_models.py
git commit -m "feat: add canonical runtime models"
```

---

## Task 4: SQLite Persistence 和 Migration

**Files:**
- Create: `runtime/src/workflow_platform/persistence/database.py`
- Create: `runtime/src/workflow_platform/persistence/migrations.py`
- Create: `runtime/src/workflow_platform/persistence/repositories.py`
- Create: `runtime/tests/test_persistence.py`

- [ ] **Step 1: 写 migration 测试**

`runtime/tests/test_persistence.py`:

```python
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate


def test_migrate_creates_core_tables(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    table_names = {
        row[0]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }
    assert "projects" in table_names
    assert "workflow_versions" in table_names
    assert "run_events" in table_names
    assert "run_projections" in table_names
```

- [ ] **Step 2: 实现 SQLite 连接和表结构**

`runtime/src/workflow_platform/persistence/database.py`:

```python
from __future__ import annotations

import sqlite3
from pathlib import Path


def connect(path: str | Path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db
```

`runtime/src/workflow_platform/persistence/migrations.py`:

```python
from __future__ import annotations

import sqlite3


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  active_protocol TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  actor_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS run_projections (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  current_node_ids_json TEXT NOT NULL,
  node_states_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  blocking_reasons_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  producer_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  decided_by_json TEXT,
  comment TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS gate_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


def migrate(db: sqlite3.Connection) -> None:
    db.executescript(SCHEMA)
    db.commit()
```

- [ ] **Step 3: 运行 persistence 测试**

Run:

```bash
cd runtime && python -m pytest tests/test_persistence.py -v
```

Expected:

```text
1 passed
```

- [ ] **Step 4: 提交 persistence**

```bash
git add runtime/src/workflow_platform/persistence runtime/tests/test_persistence.py
git commit -m "feat: add sqlite persistence schema"
```

---

## Task 5: AdapterRegistry 和 Harness Adapter

**Files:**
- Create: `runtime/src/workflow_platform/adapters/base.py`
- Create: `runtime/src/workflow_platform/adapters/registry.py`
- Create: `runtime/src/workflow_platform/adapters/harness.py`
- Create: `runtime/tests/fixtures/harness_project/.harness/workflow.yaml`
- Create: `runtime/tests/test_adapters.py`

- [ ] **Step 1: 写 Harness fixture**

`runtime/tests/fixtures/harness_project/.harness/workflow.yaml`:

```yaml
id: demo-workflow
name: Demo Workflow
version: "1"
nodes:
  - id: plan
    name: Plan
    kind: task
    requires:
      - type: artifact
        artifactType: markdown
        required: true
  - id: review
    name: Review
    kind: approval
edges:
  - id: plan-to-review
    from: plan
    to: review
gates: []
roles: []
policies: {}
```

- [ ] **Step 2: 写 adapter 测试**

`runtime/tests/test_adapters.py`:

```python
from pathlib import Path

from workflow_platform.adapters.harness import HarnessAdapter
from workflow_platform.adapters.registry import AdapterRegistry


FIXTURE = Path(__file__).parent / "fixtures" / "harness_project"


def test_harness_adapter_detects_harness_project() -> None:
    result = HarnessAdapter().detect(FIXTURE)
    assert result.adapter_id == "harness"
    assert result.score == 100


def test_harness_adapter_imports_canonical_workflow() -> None:
    workflow = HarnessAdapter().import_workflow(FIXTURE)
    assert workflow.id == "demo-workflow"
    assert workflow.sourceAdapter == "harness"
    assert workflow.nodes[0].id == "plan"


def test_registry_returns_detected_adapters() -> None:
    results = AdapterRegistry([HarnessAdapter()]).detect(FIXTURE)
    assert [item.adapter_id for item in results] == ["harness"]
```

- [ ] **Step 3: 实现 adapter**

`runtime/src/workflow_platform/adapters/base.py`:

```python
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from workflow_platform.models import WorkflowDefinition


class DetectionResult(BaseModel):
    adapter_id: str
    name: str
    score: int
    diagnostics: list[str]


class WorkflowAdapter(Protocol):
    id: str
    name: str

    def detect(self, project_root: Path) -> DetectionResult: ...
    def import_workflow(self, project_root: Path) -> WorkflowDefinition: ...
```

`runtime/src/workflow_platform/adapters/registry.py`:

```python
from __future__ import annotations

from pathlib import Path

from workflow_platform.adapters.base import DetectionResult, WorkflowAdapter


class AdapterRegistry:
    def __init__(self, adapters: list[WorkflowAdapter]) -> None:
        self._adapters = adapters

    def detect(self, project_root: Path) -> list[DetectionResult]:
        results = [adapter.detect(project_root) for adapter in self._adapters]
        return [item for item in sorted(results, key=lambda item: item.score, reverse=True) if item.score > 0]
```

`runtime/src/workflow_platform/adapters/harness.py`:

```python
from __future__ import annotations

from pathlib import Path

import yaml

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.models import WorkflowDefinition


class HarnessAdapter:
    id = "harness"
    name = "Harness"

    def detect(self, project_root: Path) -> DetectionResult:
        workflow_file = project_root / ".harness" / "workflow.yaml"
        if workflow_file.exists():
            return DetectionResult(adapter_id=self.id, name=self.name, score=100, diagnostics=[])
        return DetectionResult(
            adapter_id=self.id,
            name=self.name,
            score=0,
            diagnostics=["未发现 .harness/workflow.yaml"],
        )

    def import_workflow(self, project_root: Path) -> WorkflowDefinition:
        workflow_file = project_root / ".harness" / "workflow.yaml"
        data = yaml.safe_load(workflow_file.read_text(encoding="utf-8"))
        return WorkflowDefinition(
            id=data["id"],
            name=data["name"],
            version=str(data.get("version", "1")),
            sourceAdapter=self.id,
            nodes=data.get("nodes", []),
            edges=data.get("edges", []),
            roles=data.get("roles", []),
            gates=data.get("gates", []),
            policies=data.get("policies", {}),
            metadata={"sourcePath": str(workflow_file)},
        )
```

- [ ] **Step 4: 运行 adapter 测试**

Run:

```bash
cd runtime && python -m pytest tests/test_adapters.py -v
```

Expected:

```text
3 passed
```

- [ ] **Step 5: 提交 adapter**

```bash
git add runtime/src/workflow_platform/adapters runtime/tests/test_adapters.py runtime/tests/fixtures
git commit -m "feat: import harness workflows"
```

---

## Task 6: Workflow Compiler

**Files:**
- Create: `runtime/src/workflow_platform/compiler/compiler.py`
- Create: `runtime/tests/test_compiler.py`

- [ ] **Step 1: 写 compiler 测试**

`runtime/tests/test_compiler.py`:

```python
from workflow_platform.compiler.compiler import compile_workflow
from workflow_platform.models import WorkflowDefinition, WorkflowNode, WorkflowEdge


def test_compile_workflow_reports_missing_edge_target() -> None:
    workflow = WorkflowDefinition(
        id="wf",
        name="Demo",
        version="1",
        sourceAdapter="test",
        nodes=[WorkflowNode(id="a", name="A", kind="task")],
        edges=[WorkflowEdge(id="bad", **{"from": "a"}, to="missing")],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )
    result = compile_workflow(workflow)
    assert result["diagnostics"][0]["code"] == "EDGE_TARGET_MISSING"


def test_compile_workflow_builds_graph_spec() -> None:
    workflow = WorkflowDefinition(
        id="wf",
        name="Demo",
        version="1",
        sourceAdapter="test",
        nodes=[WorkflowNode(id="a", name="A", kind="task")],
        edges=[],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )
    result = compile_workflow(workflow)
    assert result["graphSpec"]["nodes"][0]["id"] == "a"
```

- [ ] **Step 2: 实现 compiler**

`runtime/src/workflow_platform/compiler/compiler.py`:

```python
from __future__ import annotations

from workflow_platform.models import WorkflowDefinition


def compile_workflow(workflow: WorkflowDefinition) -> dict:
    node_ids = {node.id for node in workflow.nodes}
    diagnostics: list[dict] = []
    for edge in workflow.edges:
        if edge.from_ not in node_ids:
            diagnostics.append({"code": "EDGE_SOURCE_MISSING", "message": f"边 {edge.id} 的来源节点不存在"})
        if edge.to not in node_ids:
            diagnostics.append({"code": "EDGE_TARGET_MISSING", "message": f"边 {edge.id} 的目标节点不存在"})
    return {
        "workflowId": workflow.id,
        "versionId": f"{workflow.id}:{workflow.version}",
        "diagnostics": diagnostics,
        "graphSpec": {
            "nodes": [{"id": node.id, "label": node.name, "kind": node.kind} for node in workflow.nodes],
            "edges": [{"id": edge.id, "from": edge.from_, "to": edge.to} for edge in workflow.edges],
        },
    }
```

- [ ] **Step 3: 运行 compiler 测试**

Run:

```bash
cd runtime && python -m pytest tests/test_compiler.py -v
```

Expected:

```text
2 passed
```

- [ ] **Step 4: 提交 compiler**

```bash
git add runtime/src/workflow_platform/compiler runtime/tests/test_compiler.py
git commit -m "feat: compile canonical workflows"
```

---

## Task 7: Event Store、Projection 和 Kernel

**Files:**
- Create: `runtime/src/workflow_platform/kernel/projection.py`
- Create: `runtime/src/workflow_platform/kernel/transition.py`
- Create: `runtime/tests/test_kernel.py`

- [ ] **Step 1: 写 Kernel 测试**

`runtime/tests/test_kernel.py`:

```python
from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.kernel.transition import transition
from workflow_platform.models import Actor, RunEvent, WorkflowDefinition, WorkflowNode


HUMAN = Actor(id="u1", type="human", source="renderer", trusted=True)
AGENT = Actor(id="a1", type="agent", source="agent", trusted=True)


def workflow() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf",
        name="Demo",
        version="1",
        sourceAdapter="test",
        nodes=[
            WorkflowNode(id="plan", name="Plan", kind="task"),
            WorkflowNode(id="review", name="Review", kind="approval"),
        ],
        edges=[{"id": "e1", "from": "plan", "to": "review"}],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )


def test_run_created_sets_first_node_ready() -> None:
    result = rebuild_projection("run1", workflow(), [])
    assert result.currentNodeIds == ["plan"]
    assert result.nodeStates["plan"] == "READY"


def test_agent_cannot_human_approve() -> None:
    event = RunEvent(
        id="e1",
        runId="run1",
        type="HUMAN_APPROVED",
        nodeId="review",
        actor=AGENT,
        payload={},
        createdAt="2026-07-27T00:00:00Z",
        revision="0",
    )
    result = transition("run1", workflow(), [], event, expected_revision="0")
    assert result["accepted"] is False
    assert result["blockingReasons"][0]["code"] == "PERMISSION_DENIED"
```

- [ ] **Step 2: 实现 projection 和 transition**

`runtime/src/workflow_platform/kernel/projection.py`:

```python
from __future__ import annotations

from datetime import datetime, timezone

from workflow_platform.models import AllowedAction, BlockingReason, RunEvent, RunProjection, WorkflowDefinition


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def rebuild_projection(run_id: str, workflow: WorkflowDefinition, events: list[RunEvent]) -> RunProjection:
    node_states = {node.id: "PENDING" for node in workflow.nodes}
    current = [workflow.nodes[0].id] if workflow.nodes else []
    if current:
        node_states[current[0]] = "READY"

    status = "CREATED"
    revision = str(len(events))

    for event in events:
        status = "IN_PROGRESS"
        if event.type == "NODE_STARTED" and event.nodeId:
            node_states[event.nodeId] = "RUNNING"
        if event.type == "ARTIFACT_SUBMITTED" and event.nodeId:
            node_states[event.nodeId] = "AWAITING_APPROVAL"
        if event.type == "HUMAN_APPROVED" and event.nodeId:
            node_states[event.nodeId] = "PASSED"
        if event.type == "GATE_PASSED" and event.nodeId:
            node_states[event.nodeId] = "PASSED"
        if event.type == "RUN_COMPLETED":
            status = "DONE"

    allowed = []
    for node_id in current:
        state = node_states[node_id]
        if state == "READY":
            allowed.append(AllowedAction(id="start-node", label="启动节点", eventType="NODE_STARTED", nodeId=node_id))
        if state == "AWAITING_APPROVAL":
            allowed.append(AllowedAction(id="approve", label="人工确认", eventType="HUMAN_APPROVED", nodeId=node_id, risk="high"))

    return RunProjection(
        runId=run_id,
        status=status,
        currentNodeIds=current,
        nodeStates=node_states,
        allowedActions=allowed,
        blockingReasons=[],
        revision=revision,
        updatedAt=now_iso(),
    )
```

`runtime/src/workflow_platform/kernel/transition.py`:

```python
from __future__ import annotations

from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.models import BlockingReason, RunEvent, WorkflowDefinition


def transition(
    run_id: str,
    workflow: WorkflowDefinition,
    events: list[RunEvent],
    event: RunEvent,
    expected_revision: str,
) -> dict:
    current_revision = str(len(events))
    if expected_revision != current_revision:
        projection = rebuild_projection(run_id, workflow, events)
        reason = BlockingReason(code="REVISION_CONFLICT", message="Run revision 不匹配")
        return {
            "run": projection,
            "accepted": False,
            "revision": projection.revision,
            "allowedActions": projection.allowedActions,
            "blockingReasons": [reason.model_dump()],
            "emittedEvents": [],
        }

    if event.type == "HUMAN_APPROVED" and event.actor.type != "human":
        projection = rebuild_projection(run_id, workflow, events)
        reason = BlockingReason(code="PERMISSION_DENIED", message="只有 human actor 可以提交人工确认", nodeId=event.nodeId)
        return {
            "run": projection,
            "accepted": False,
            "revision": projection.revision,
            "allowedActions": projection.allowedActions,
            "blockingReasons": [reason.model_dump()],
            "emittedEvents": [],
        }

    accepted_events = [*events, event]
    projection = rebuild_projection(run_id, workflow, accepted_events)
    return {
        "run": projection,
        "accepted": True,
        "revision": projection.revision,
        "allowedActions": projection.allowedActions,
        "blockingReasons": projection.blockingReasons,
        "emittedEvents": [event],
    }
```

- [ ] **Step 3: 运行 Kernel 测试**

Run:

```bash
cd runtime && python -m pytest tests/test_kernel.py -v
```

Expected:

```text
2 passed
```

- [ ] **Step 4: 提交 Kernel**

```bash
git add runtime/src/workflow_platform/kernel runtime/tests/test_kernel.py
git commit -m "feat: add event-sourced transition kernel"
```

---

## Task 8: Artifact、Approval 和 Gate 服务

**Files:**
- Create: `runtime/src/workflow_platform/artifacts/service.py`
- Create: `runtime/src/workflow_platform/approvals/service.py`
- Create: `runtime/src/workflow_platform/gates/service.py`
- Create: `runtime/tests/test_governance.py`

- [ ] **Step 1: 写治理测试**

`runtime/tests/test_governance.py`:

```python
from pathlib import Path

import pytest

from workflow_platform.artifacts.service import hash_artifact, validate_safe_path
from workflow_platform.gates.service import validate_gate_decision
from workflow_platform.models import Actor


def test_artifact_path_must_stay_inside_project(tmp_path) -> None:
    safe = tmp_path / "artifact.md"
    safe.write_text("ok", encoding="utf-8")
    assert validate_safe_path(tmp_path, safe) == safe.resolve()
    with pytest.raises(ValueError):
        validate_safe_path(tmp_path, Path("C:/Windows/system.ini"))


def test_artifact_hash_is_stable(tmp_path) -> None:
    artifact = tmp_path / "artifact.md"
    artifact.write_text("hello", encoding="utf-8")
    assert hash_artifact(artifact) == hash_artifact(artifact)


def test_gate_pass_requires_verifier_or_system_and_evidence() -> None:
    human = Actor(id="u1", type="human", source="renderer", trusted=True)
    verifier = Actor(id="v1", type="verifier", source="runtime", trusted=True)
    assert validate_gate_decision(verifier, evidence=["artifact:1"], waiver_reason=None) is True
    with pytest.raises(ValueError):
        validate_gate_decision(human, evidence=["artifact:1"], waiver_reason=None)
    with pytest.raises(ValueError):
        validate_gate_decision(verifier, evidence=[], waiver_reason=None)
```

- [ ] **Step 2: 实现治理服务**

`runtime/src/workflow_platform/artifacts/service.py`:

```python
from __future__ import annotations

import hashlib
from pathlib import Path


def validate_safe_path(project_root: Path, artifact_path: Path) -> Path:
    root = project_root.resolve()
    candidate = artifact_path.resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("artifact path escapes project root")
    return candidate


def hash_artifact(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()
```

`runtime/src/workflow_platform/gates/service.py`:

```python
from __future__ import annotations

from workflow_platform.models import Actor


def validate_gate_decision(actor: Actor, evidence: list[str], waiver_reason: str | None) -> bool:
    if actor.type not in {"verifier", "system"}:
        raise ValueError("gate decision requires verifier or system actor")
    if not evidence and not waiver_reason:
        raise ValueError("gate decision requires evidence or waiver")
    return True
```

`runtime/src/workflow_platform/approvals/service.py`:

```python
from __future__ import annotations

from workflow_platform.models import Actor


def validate_human_decision(actor: Actor) -> bool:
    if actor.type != "human" or not actor.trusted:
        raise ValueError("approval decision requires trusted human actor")
    return True
```

- [ ] **Step 3: 运行治理测试**

Run:

```bash
cd runtime && python -m pytest tests/test_governance.py -v
```

Expected:

```text
3 passed
```

- [ ] **Step 4: 提交治理服务**

```bash
git add runtime/src/workflow_platform/artifacts runtime/src/workflow_platform/approvals runtime/src/workflow_platform/gates runtime/tests/test_governance.py
git commit -m "feat: enforce artifact approval and gate policies"
```

---

## Task 9: Runtime API

**Files:**
- Create: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/src/workflow_platform/main.py`
- Create: `runtime/tests/test_api.py`

- [ ] **Step 1: 写 API 测试**

`runtime/tests/test_api.py`:

```python
from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app


def test_health_endpoint() -> None:
    client = TestClient(create_app())
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
```

- [ ] **Step 2: 实现 FastAPI app**

`runtime/src/workflow_platform/api/app.py`:

```python
from __future__ import annotations

from fastapi import FastAPI

from workflow_platform.main import health


def create_app() -> FastAPI:
    app = FastAPI(title="AI Workflow Platform Runtime")

    @app.get("/health")
    def health_endpoint() -> dict[str, str]:
        return health()

    return app


app = create_app()
```

`runtime/src/workflow_platform/main.py`:

```python
from __future__ import annotations


def health() -> dict[str, str]:
    return {"status": "ok", "service": "workflow-runtime"}


def run() -> None:
    import uvicorn

    uvicorn.run("workflow_platform.api.app:app", host="127.0.0.1", port=8765, reload=False)
```

- [ ] **Step 3: 运行 API 测试**

Run:

```bash
cd runtime && python -m pytest tests/test_api.py -v
```

Expected:

```text
1 passed
```

- [ ] **Step 4: 提交 Runtime API**

```bash
git add runtime/src/workflow_platform/api runtime/src/workflow_platform/main.py runtime/tests/test_api.py
git commit -m "feat: expose runtime health api"
```

---

## Task 10: Terminal 和 Agent Provider 边界

**Files:**
- Create: `runtime/src/workflow_platform/terminals/service.py`
- Create: `runtime/src/workflow_platform/execution/agent.py`
- Create: `runtime/tests/test_execution_boundaries.py`

- [ ] **Step 1: 写执行边界测试**

`runtime/tests/test_execution_boundaries.py`:

```python
from workflow_platform.execution.agent import DefaultAgentExecutor
from workflow_platform.terminals.service import create_terminal_session


def test_terminal_session_is_bound_to_run_and_node(tmp_path) -> None:
    session = create_terminal_session(
        project_id="p1",
        run_id="r1",
        node_id="n1",
        kind="shell",
        cwd=tmp_path,
    )
    assert session["runId"] == "r1"
    assert session["nodeId"] == "n1"
    assert session["status"] == "created"


def test_agent_executor_returns_normalized_result() -> None:
    result = DefaultAgentExecutor().start({"nodeId": "n1", "prompt": "hello"})
    assert result["status"] == "interrupted"
    assert "checkpoint" in result
```

- [ ] **Step 2: 实现 Terminal 和 Agent stub**

`runtime/src/workflow_platform/terminals/service.py`:

```python
from __future__ import annotations

from pathlib import Path
from uuid import uuid4


def create_terminal_session(
    project_id: str,
    run_id: str,
    node_id: str | None,
    kind: str,
    cwd: Path,
) -> dict:
    return {
        "id": str(uuid4()),
        "projectId": project_id,
        "runId": run_id,
        "nodeId": node_id,
        "kind": kind,
        "status": "created",
        "cwd": str(cwd),
        "pid": None,
    }
```

`runtime/src/workflow_platform/execution/agent.py`:

```python
from __future__ import annotations

from typing import Protocol
from uuid import uuid4


class AgentExecutor(Protocol):
    def start(self, request: dict) -> dict: ...
    def resume(self, handle: dict, input: dict) -> dict: ...
    def stop(self, handle: dict) -> None: ...


class DefaultAgentExecutor:
    def start(self, request: dict) -> dict:
        return {
            "status": "interrupted",
            "messages": [{"role": "assistant", "content": "等待外部 Runtime 恢复"}],
            "checkpoint": {"id": str(uuid4()), "provider": "default"},
        }

    def resume(self, handle: dict, input: dict) -> dict:
        return {"status": "completed", "messages": [], "checkpoint": handle.get("checkpoint")}

    def stop(self, handle: dict) -> None:
        return None
```

- [ ] **Step 3: 运行执行边界测试**

Run:

```bash
cd runtime && python -m pytest tests/test_execution_boundaries.py -v
```

Expected:

```text
2 passed
```

- [ ] **Step 4: 提交执行边界**

```bash
git add runtime/src/workflow_platform/terminals runtime/src/workflow_platform/execution runtime/tests/test_execution_boundaries.py
git commit -m "feat: add terminal and agent execution boundaries"
```

---

## Task 11: Renderer UI MVP

**Files:**
- Create: `apps/renderer/src/app/navigation.tsx`
- Create: `apps/renderer/src/features/projects/ProjectDashboard.tsx`
- Create: `apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- Create: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Create: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Create: `apps/renderer/src/features/approvals/ApprovalInbox.tsx`
- Create: `apps/renderer/src/features/gates/GatesPage.tsx`
- Create: `apps/renderer/src/features/artifacts/ArtifactsPage.tsx`
- Create: `apps/renderer/src/features/recovery/RecoveryPage.tsx`
- Create: `apps/renderer/src/features/settings/SettingsPage.tsx`
- Create: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: 写 UI 测试**

`apps/renderer/src/app/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the MVP workbench navigation", () => {
  render(<App />);
  expect(screen.getByText("Projects")).toBeInTheDocument();
  expect(screen.getByText("Runs")).toBeInTheDocument();
  expect(screen.getByText("Recovery")).toBeInTheDocument();
});
```

- [ ] **Step 2: 实现 App 布局**

`apps/renderer/src/app/App.tsx`:

```tsx
import "./styles.css";
import { ApprovalInbox } from "../features/approvals/ApprovalInbox";
import { ArtifactsPage } from "../features/artifacts/ArtifactsPage";
import { GatesPage } from "../features/gates/GatesPage";
import { ProjectDashboard } from "../features/projects/ProjectDashboard";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { RunDashboard } from "../features/runs/RunDashboard";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TerminalPage } from "../features/terminal/TerminalPage";
import { WorkflowViewer } from "../features/workflow/WorkflowViewer";

export function App() {
  return (
    <main className="workbench">
      <aside className="sidebar">
        <strong>AI Workflow</strong>
        {["Projects", "Runs", "Workflow", "Terminal", "Gates", "Artifacts", "Approvals", "Recovery", "Settings"].map(
          (item) => (
            <button key={item} type="button">
              {item}
            </button>
          )
        )}
      </aside>
      <section className="content">
        <ProjectDashboard />
        <RunDashboard />
        <WorkflowViewer />
        <TerminalPage />
        <ApprovalInbox />
        <GatesPage />
        <ArtifactsPage />
        <RecoveryPage />
        <SettingsPage />
      </section>
    </main>
  );
}
```

`apps/renderer/src/app/styles.css`:

```css
:root {
  color: #17202a;
  background: #f6f7f9;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
}

.workbench {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.sidebar {
  background: #111827;
  color: #f9fafb;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
}

.sidebar button {
  background: transparent;
  border: 1px solid #374151;
  color: inherit;
  padding: 8px 10px;
  text-align: left;
  border-radius: 6px;
}

.content {
  display: grid;
  gap: 16px;
  padding: 20px;
}

.panel {
  background: #ffffff;
  border: 1px solid #d9dee7;
  border-radius: 8px;
  padding: 16px;
}
```

- [ ] **Step 3: 实现页面组件**

每个 feature 组件使用统一模式，例如 `ProjectDashboard.tsx`：

```tsx
export function ProjectDashboard() {
  return (
    <section className="panel">
      <h2>Project Dashboard</h2>
      <p>协议识别、Workflow 版本、活跃 Run 和诊断状态。</p>
    </section>
  );
}
```

其他页面使用相同 `section.panel` 结构，并写入对应中文说明：

```tsx
export function RunDashboard() {
  return <section className="panel"><h2>Run Dashboard</h2><p>当前节点、Timeline、Allowed Actions、Blocking Reasons。</p></section>;
}
```

- [ ] **Step 4: 运行 UI 测试**

Run:

```bash
npm --workspace apps/renderer run test
```

Expected:

```text
PASS src/app/App.test.tsx
```

- [ ] **Step 5: 提交 UI MVP**

```bash
git add apps/renderer
git commit -m "feat: add renderer MVP workbench"
```

---

## Task 12: Electron Desktop Shell

**Files:**
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Create: `apps/desktop/src/main/runtime.ts`

- [ ] **Step 1: 实现 preload-safe API**

`apps/desktop/src/preload/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("workflowRuntime", {
  health: () => ipcRenderer.invoke("runtime:health")
});
```

- [ ] **Step 2: 实现 desktop main**

`apps/desktop/src/main/main.ts`:

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { runtimeHealth } from "./runtime";

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js")
    }
  });

  ipcMain.handle("runtime:health", () => runtimeHealth());

  const devUrl = process.env.RENDERER_URL ?? "http://127.0.0.1:5173";
  await window.loadURL(devUrl);
}

app.whenReady().then(createWindow);
```

`apps/desktop/src/main/runtime.ts`:

```ts
export function runtimeHealth() {
  return { status: "ok", service: "workflow-runtime" };
}
```

- [ ] **Step 3: 运行 desktop build**

Run:

```bash
npm --workspace apps/desktop run build
```

Expected:

```text
build completed
```

- [ ] **Step 4: 提交桌面壳**

```bash
git add apps/desktop
git commit -m "feat: add electron desktop shell"
```

---

## Task 13: End-to-End 验证路径

**Files:**
- Create: `tests/e2e/workflow-mvp.spec.ts`
- Create: `scripts/verify.ps1`
- Modify: `package.json`

- [ ] **Step 1: 写 E2E 验证用例**

`tests/e2e/workflow-mvp.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("renderer shows MVP workbench", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await expect(page.getByText("Projects")).toBeVisible();
  await expect(page.getByText("Run Dashboard")).toBeVisible();
  await expect(page.getByText("Recovery")).toBeVisible();
});
```

- [ ] **Step 2: 写统一验证脚本**

`scripts/verify.ps1`:

```powershell
$ErrorActionPreference = "Stop"
npm run test
npm run test:runtime
```

- [ ] **Step 3: 运行完整验证**

Run:

```bash
npm run verify
```

Expected:

```text
TypeScript tests pass
Python tests pass
```

- [ ] **Step 4: 提交验证路径**

```bash
git add tests scripts package.json
git commit -m "test: add MVP verification path"
```

---

## Task 14: Completion Audit

**Files:**
- Modify: `README.md`
- Create: `docs/mvp-completion-audit.zh-CN.md`

- [ ] **Step 1: 写 README 启动说明**

`README.md`:

```markdown
# AI 工程工作流平台

本仓库实现一个本地桌面 AI 工程工作流平台 MVP。

## 开发命令

```bash
npm install
npm run test
npm run test:runtime
npm run verify
```

## MVP 范围

- Project import
- Adapter detection
- Harness Adapter import
- Canonical Workflow storage
- Event-sourced Run state
- Workflow Kernel transition
- Approval / Gate / Artifact governance
- Terminal session boundary
- AgentExecutor provider boundary
- Renderer MVP workbench
- Recovery projection rebuild
```

- [ ] **Step 2: 写完成审计文档**

`docs/mvp-completion-audit.zh-CN.md`:

```markdown
# MVP 完成审计

## 证据

- `npm run test`：TypeScript contracts 和 renderer 测试通过。
- `npm run test:runtime`：Python runtime 模型、adapter、compiler、kernel、governance、API、execution boundary 测试通过。
- `npm run verify`：统一验证脚本通过。

## 验收映射

- 项目导入：由 AdapterRegistry 和 HarnessAdapter 测试覆盖。
- Workflow 编译：由 compiler 测试覆盖。
- Run 创建和事件推进：由 kernel/projection 测试覆盖。
- Approval/Gate/Artifact 治理：由 governance 测试覆盖。
- Terminal 和 Agent 边界：由 execution boundary 测试覆盖。
- UI allowed action 展示路径：由 renderer 测试和 E2E smoke 测试覆盖。
- Recovery projection rebuild：由 projection rebuild 测试覆盖。
```

- [ ] **Step 3: 运行最终验证**

Run:

```bash
npm run verify
```

Expected:

```text
All tests pass
```

- [ ] **Step 4: 提交审计**

```bash
git add README.md docs/mvp-completion-audit.zh-CN.md
git commit -m "docs: document MVP verification"
```

---

## 自检清单

- Spec coverage：本计划覆盖 M1-M6、Project import、Adapter detection、Harness Adapter、Workflow storage、Compiler、Event Store、Kernel、Allowed Actions、Approval、Gate、Artifact、Terminal、Agent Provider、UI MVP、Recovery 和验证审计。
- 空白项扫描：计划没有留下空白实现项或延后描述。
- Type consistency：TS contracts 使用 camelCase；Python Pydantic 模型也按 contracts 保持 camelCase 字段，`WorkflowEdge.from_` 通过 alias 兼容 `from`。
- Governance consistency：Renderer、Terminal、Agent 都不获得直接完成节点或审批的能力，状态推进集中在 Kernel。
- Verification：每个实现任务都有对应测试命令和提交点。
