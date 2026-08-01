# Workflow Canvas and Role Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a React Flow editor and platform-managed role definitions that Agent nodes bind into Runtime prompts.

**Architecture:** The canonical workflow stores full role definitions and optional canvas positions in versioned `metadata`; existing `definition_json` persistence therefore captures a Run's role snapshot. Runtime validates references and composes a role section before node instructions. The renderer projects the existing JSON draft to `@xyflow/react`, retaining JSON editing as a recovery path.

**Tech Stack:** React 18, TypeScript, `@xyflow/react`, Vitest, FastAPI, Pydantic, SQLite, pytest, Playwright.

---

## File Structure

- `packages/contracts/src/workflow.ts`: role and canvas TypeScript types.
- `runtime/src/workflow_platform/models.py`: Pydantic role model.
- `runtime/src/workflow_platform/compiler/compiler.py`: role and layout diagnostics.
- `runtime/src/workflow_platform/runtime_service.py`: role-aware effective prompt.
- `apps/renderer/src/features/workflow/workflowCanvas.ts`: pure Flow/draft conversions.
- `apps/renderer/src/features/workflow/WorkflowCanvas.tsx`: React Flow interaction surface.
- `apps/renderer/src/features/workflow/RoleLibrary.tsx`: platform templates and role editing UI.
- `apps/renderer/src/features/workflow/WorkflowViewer.tsx`: composition and selected-node inspector.
- `apps/renderer/src/features/runs/RunDashboard.tsx`: apply the bound role's Provider and tool defaults when a node is selected.
- `apps/renderer/src/app/App.tsx`: pass the immutable workflow definition and resolved launch options through the Agent start callback.

### Task 1: Extend the Canonical Definition

**Files:**
- Modify: `package.json`, `apps/renderer/package.json`, `package-lock.json`
- Modify: `packages/contracts/src/workflow.ts`
- Test: `packages/contracts/src/contracts.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
it("accepts a versioned role and canvas coordinates", () => {
  const workflow: WorkflowDefinition = {
    ...baseWorkflow,
    roles: [{ id: "developer", name: "Developer", instructions: "Implement only the approved plan.", provider: "codex", allowedTools: ["read", "edit", "test"] }],
    nodes: [{ ...baseWorkflow.nodes[0], kind: "agent", role: "developer" }],
    metadata: { canvas: { nodes: { plan: { x: 240, y: 96 } } } },
  };
  expect(workflow.roles[0].instructions).toContain("approved plan");
  expect(workflow.metadata.canvas?.nodes.plan).toEqual({ x: 240, y: 96 });
});
```

- [ ] **Step 2: Verify that it fails**

Run: `npm.cmd --workspace @workflow-platform/contracts run test`

Expected: failure because `roles` only supports `id` and `name`, and canvas metadata is untyped.

- [ ] **Step 3: Implement the contract**

```ts
export type WorkflowRole = {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  provider?: "codex" | "claude";
  allowedTools?: string[];
  disabled?: boolean;
  metadata?: Record<string, unknown>;
};

export type WorkflowMetadata = Record<string, unknown> & {
  canvas?: { nodes: Record<string, { x: number; y: number }> };
};
```

Use `WorkflowRole[]` for `WorkflowDefinition.roles` and `WorkflowMetadata` for `metadata`. Leave the existing optional `WorkflowNode.role` unchanged.

- [ ] **Step 4: Add the canvas dependency**

Run: `npm.cmd install --workspace @workflow-platform/renderer @xyflow/react`

Expected: the renderer workspace and lockfile contain `@xyflow/react`.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd --workspace @workflow-platform/contracts run test`

Expected: PASS.

```bash
git add package.json apps/renderer/package.json package-lock.json packages/contracts/src/workflow.ts packages/contracts/src/contracts.test.ts
git commit -m "feat: add workflow role and canvas contracts"
```

### Task 2: Validate Roles and Inject Them Into Agent Execution

**Files:**
- Modify: `runtime/src/workflow_platform/models.py`
- Modify: `runtime/src/workflow_platform/compiler/compiler.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Test: `runtime/tests/test_compiler.py`, `runtime/tests/test_runtime_service.py`

- [ ] **Step 1: Write failing compiler tests**

```py
def test_compile_workflow_rejects_invalid_role_references() -> None:
    workflow = _workflow(
        nodes=[WorkflowNode(id="implement", name="Implement", kind="agent", role="missing")],
        roles=[],
    )
    codes = {item["code"] for item in compile_workflow(workflow)["diagnostics"]}
    assert "NODE_ROLE_MISSING" in codes

def test_compile_workflow_rejects_role_on_non_agent_node() -> None:
    workflow = _workflow(
        nodes=[WorkflowNode(id="review", name="Review", kind="approval", role="developer")],
        roles=[Role(id="developer", name="Developer", instructions="Review code")],
    )
    codes = {item["code"] for item in compile_workflow(workflow)["diagnostics"]}
    assert "NODE_ROLE_UNSUPPORTED" in codes
```

- [ ] **Step 2: Verify failure**

Run: `cd runtime; python -m pytest tests/test_compiler.py -k role -v`

Expected: failure because `Role` lacks instructions and the compiler does not validate roles.

- [ ] **Step 3: Implement model and compiler validation**

```py
class Role(CanonicalModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str | None = None
    instructions: str = ""
    provider: AgentProvider | None = None
    allowedTools: list[str] = Field(default_factory=list)
    disabled: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)
```

Build a role map in `compile_workflow`. Emit `DUPLICATE_ROLE_ID`, `INVALID_ROLE_DEFINITION`, `NODE_ROLE_MISSING`, `NODE_ROLE_DISABLED`, and `NODE_ROLE_UNSUPPORTED`. A no-role Agent node remains valid. Validate `metadata.canvas` only as an editor warning: ignore unknown node IDs and non-finite coordinates instead of making layout execution data.

- [ ] **Step 4: Write the failing prompt-order test**

```py
def test_start_agent_job_includes_role_before_node_requirements(tmp_path) -> None:
    service, run_id = _service_with_agent_role(tmp_path)
    result = _start_fake_agent(service, run_id, node_id="implement")
    prompt = result["effectivePrompt"]
    assert prompt.index("角色定义：") < prompt.index("节点执行要求：")
    assert "Implement only the approved plan." in prompt
```

- [ ] **Step 5: Implement effective prompt composition**

```py
if node.role:
    role = next(candidate for candidate in workflow.roles if candidate.id == node.role)
    lines = [f"角色：{role.name}"]
    if role.description:
        lines.append(f"说明：{role.description}")
    lines.append(f"职责与边界：\n{role.instructions.strip()}")
    sections.append("角色定义：\n" + "\n".join(lines))
```

Put this block before the existing `node.agent.promptTemplate` block. Runtime validates role defaults but uses the Provider and allowed tools explicitly resolved by the renderer at launch; persist those actual values in the job/audit payload and never read a `.harness` or project-relative role file.

- [ ] **Step 6: Verify and commit**

Run: `cd runtime; python -m pytest tests/test_compiler.py tests/test_runtime_service.py -v`

Expected: PASS, including existing Agent nodes with no role.

```bash
git add runtime/src/workflow_platform/models.py runtime/src/workflow_platform/compiler/compiler.py runtime/src/workflow_platform/runtime_service.py runtime/tests/test_compiler.py runtime/tests/test_runtime_service.py
git commit -m "feat: bind workflow roles to agent execution"
```

### Task 3: Implement Pure Flow/Draft Conversion

**Files:**
- Create: `apps/renderer/src/features/workflow/workflowCanvas.ts`
- Create: `apps/renderer/src/features/workflow/workflowCanvas.test.ts`
- Modify: `apps/renderer/src/app/runtimeClient.ts`

- [ ] **Step 1: Write failing conversion tests**

```ts
it("projects unpositioned workflow nodes and edges to Flow", () => {
  const graph = toFlowGraph(workflowWithoutCanvas);
  expect(graph.nodes[0].position).toEqual({ x: 0, y: 0 });
  expect(graph.edges[0]).toMatchObject({ id: "plan-implement", source: "plan", target: "implement" });
});

it("writes dragged positions only to metadata", () => {
  const next = applyNodePositions(workflowWithoutCanvas, [{ id: "plan", position: { x: 320, y: 160 } }]);
  expect(next.metadata.canvas?.nodes.plan).toEqual({ x: 320, y: 160 });
  expect(next.nodes).toEqual(workflowWithoutCanvas.nodes);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm.cmd --workspace @workflow-platform/renderer run test -- workflowCanvas.test.ts`

Expected: failure because `workflowCanvas.ts` does not exist.

- [ ] **Step 3: Implement renderer DTOs and helpers**

Add the full `WorkflowRoleSummary` and `node.role` types to `WorkflowDefinitionSummary`. Implement `toFlowGraph`, `applyNodePositions`, `addFlowEdge`, `removeFlowEdges`, and `autoLayoutPositions`. The layout algorithm uses topological layers, 260px horizontal spacing, 150px vertical spacing, and lexical ID ordering for disconnected nodes. Every helper returns a new draft object and rejects self/duplicate edges.

- [ ] **Step 4: Verify and commit**

Run: `npm.cmd --workspace @workflow-platform/renderer run test -- workflowCanvas.test.ts`

Expected: PASS.

```bash
git add apps/renderer/src/app/runtimeClient.ts apps/renderer/src/features/workflow/workflowCanvas.ts apps/renderer/src/features/workflow/workflowCanvas.test.ts
git commit -m "feat: map workflow drafts to flow canvas state"
```

### Task 4: Render and Edit the Flow Canvas

**Files:**
- Create: `apps/renderer/src/features/workflow/WorkflowCanvas.tsx`
- Modify: `apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- Modify: `apps/renderer/src/app/styles.css`
- Test: `apps/renderer/src/features/workflow/WorkflowViewer.test.tsx`

- [ ] **Step 1: Write the failing canvas interaction test**

```tsx
it("selects a canvas node and saves an edge created on the canvas", () => {
  render(<WorkflowViewer state={null} workflow={twoNodeWorkflow} onSaveDefinition={onSaveDefinition} />);
  fireEvent.click(screen.getByRole("button", { name: "选择节点 plan" }));
  expect(screen.getByLabelText("节点 plan 的角色")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "连接 plan 到 implement" }));
  fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
  expect(onSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({ edges: [expect.objectContaining({ from: "plan", to: "implement" })] }));
});
```

- [ ] **Step 2: Verify failure**

Run: `npm.cmd --workspace @workflow-platform/renderer run test -- WorkflowViewer.test.tsx`

Expected: failure because the Flow canvas and selected-node inspector do not exist.

- [ ] **Step 3: Implement the canvas component**

```tsx
<ReactFlow
  nodes={nodes}
  edges={edges}
  onNodeClick={(_, node) => onSelectNode(node.id)}
  onNodesChange={handleNodesChange}
  onEdgesChange={handleEdgesChange}
  onConnect={({ source, target }) => source && target && onConnect(source, target)}
  fitView
>
  <Background gap={20} size={1} />
  <Controls />
  <MiniMap />
</ReactFlow>
```

Import `@xyflow/react/dist/style.css` in this component. Custom nodes show name, kind, bound role, Run state, validation state and source/target handles. On drag stop call `applyNodePositions`; on connect call `addFlowEdge`. Provide visually-hidden accessible node and connection buttons for keyboard users and tests.

- [ ] **Step 4: Compose the canvas with a selected-node inspector**

Replace the repeated node cards plus source/target selects in `WorkflowViewer` with a three-column `.workflow-editor`: node toolbox, canvas, and inspector. Retain the JSON editor, simulation, export, history, reset and save controls. The inspector owns node type, role, Agent, Artifact, advance mode and delete actions. Changing away from `kind: "agent"` clears `agent` and `role`.

- [ ] **Step 5: Add responsive styles**

```css
.workflow-editor { display: grid; grid-template-columns: 200px minmax(420px, 1fr) minmax(300px, 380px); min-height: 620px; }
.workflow-canvas { min-height: 620px; border: 1px solid var(--border); }
@media (max-width: 980px) {
  .workflow-editor { grid-template-columns: 1fr; }
  .workflow-canvas { min-height: 460px; }
}
```

- [ ] **Step 6: Verify and commit**

Run: `npm.cmd --workspace @workflow-platform/renderer run test; npm.cmd --workspace @workflow-platform/renderer run build`

Expected: PASS.

```bash
git add apps/renderer/src/features/workflow/WorkflowCanvas.tsx apps/renderer/src/features/workflow/WorkflowViewer.tsx apps/renderer/src/app/styles.css apps/renderer/src/features/workflow/WorkflowViewer.test.tsx
git commit -m "feat: edit workflow graphs on a flow canvas"
```

### Task 5: Add the Platform Role Library

**Files:**
- Create: `apps/renderer/src/features/workflow/RoleLibrary.tsx`
- Modify: `apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Modify: `apps/renderer/src/app/styles.css`
- Test: `apps/renderer/src/features/workflow/WorkflowViewer.test.tsx`
- Test: `apps/renderer/src/features/runs/RunDashboard.test.tsx`

- [ ] **Step 1: Write failing role-library tests**

```tsx
it("creates a developer role template and binds it to an Agent node", () => {
  render(<WorkflowViewer state={null} workflow={agentWorkflow} />);
  fireEvent.click(screen.getByRole("button", { name: "新增角色" }));
  fireEvent.click(screen.getByRole("button", { name: "使用开发模板" }));
  fireEvent.change(screen.getByLabelText("节点 implement 的角色"), { target: { value: "developer" } });
  expect(screen.getByDisplayValue("developer")).toBeInTheDocument();
});

it("keeps roles referenced by nodes", () => {
  render(<WorkflowViewer state={null} workflow={agentWorkflowWithDeveloper} />);
  fireEvent.click(screen.getByRole("button", { name: "删除角色 developer" }));
  expect(screen.getByText("角色仍被节点 implement 使用")).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify failure**

Run: `npm.cmd --workspace @workflow-platform/renderer run test -- WorkflowViewer.test.tsx`

Expected: failure because the role library does not exist.

- [ ] **Step 3: Implement static platform templates and editor**

```ts
export const ROLE_TEMPLATES = [
  { id: "requirement-analyst", name: "需求分析", instructions: "澄清目标、约束、风险和验收标准；不实施代码。" },
  { id: "developer", name: "开发", instructions: "只实施已确认计划；更新必要测试；不修改审批或 Gate 状态。" },
  { id: "tester", name: "测试", instructions: "执行相关测试并报告证据；不绕过失败门禁。" },
  { id: "verifier", name: "验证", instructions: "独立核对交付物与验收标准；不实施业务变更。" },
];
```

`RoleLibrary` edits `id`, `name`, `description`, `instructions`, `provider`, `allowedTools` and `disabled` through `onChange(nextRoles)`. Copy templates using a collision-free ID. Reject deletion with a rendered list of referencing node IDs. The selected-node inspector shows an `未绑定角色` option and active roles; it only appears for Agent nodes.

- [ ] **Step 4: Write a failing Run launch-default test**

```tsx
it("uses the selected node role defaults when starting an Agent", () => {
  render(<RunDashboard state={readyState} workflow={workflowWithDeveloperRole} onStartAgent={onStartAgent} />);
  fireEvent.change(screen.getByLabelText("节点 ID"), { target: { value: "implement" } });
  fireEvent.change(screen.getByLabelText("Agent 提示词"), { target: { value: "Implement the endpoint" } });
  fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
  expect(onStartAgent).toHaveBeenCalledWith("implement", "claude", "Implement the endpoint", "interactive", ["read", "edit", "test"]);
});
```

Pass `workflow` into `RunDashboard`. When `currentNodeId` changes, resolve `node.role` against `workflow.roles` and prefill `agentProvider` plus a read-only summary of the role's allowed tools. Let the operator override Provider explicitly. Extend `onStartAgent`, `handleStartAgent`, and `runtimeClient.startAgentJob` with `allowedTools: string[]`; send the resolved list in the existing API request so Runtime persists the actual launch options.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd --workspace @workflow-platform/renderer run test; npm.cmd --workspace @workflow-platform/renderer run build`

Expected: PASS.

```bash
git add apps/renderer/src/features/workflow/RoleLibrary.tsx apps/renderer/src/features/workflow/WorkflowViewer.tsx apps/renderer/src/features/runs/RunDashboard.tsx apps/renderer/src/features/runs/RunDashboard.test.tsx apps/renderer/src/app/App.tsx apps/renderer/src/app/runtimeClient.ts apps/renderer/src/app/styles.css apps/renderer/src/features/workflow/WorkflowViewer.test.tsx
git commit -m "feat: manage workflow roles in the editor"
```

### Task 6: Verify Persistence and User Journey

**Files:**
- Test: `runtime/tests/test_api.py`
- Test: `tests/e2e/workflow-p1.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing API round-trip test**

```py
def test_runtime_api_persists_roles_in_new_workflow_versions(tmp_path) -> None:
    client = TestClient(create_app(_service(tmp_path)))
    imported = _import_project(client, tmp_path)
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}").json()
    definition["roles"] = [{"id": "developer", "name": "Developer", "instructions": "Implement the approved plan."}]
    definition["nodes"][0].update({"kind": "agent", "role": "developer"})
    saved = client.post(f"/workflow-versions/{imported['workflowVersionId']}/save", json={"definition": definition, "actor": HUMAN_ACTOR, "now": NOW}).json()
    persisted = client.get(f"/workflow-versions/{saved['workflowVersionId']}").json()
    assert persisted["roles"][0]["instructions"] == "Implement the approved plan."
```

- [ ] **Step 2: Verify failure and complete serialization gaps**

Run: `cd runtime; python -m pytest tests/test_api.py -k persists_roles -v`

Expected: PASS after Tasks 1-2. If the round trip exposes an API DTO or YAML adapter gap, fix it here. Preserve missing role properties from legacy definitions with defaults. Do not add a migration: workflow definitions already persist as `definition_json`.

- [ ] **Step 3: Add the browser workflow check**

```ts
test("operator binds a platform role to a canvas node", async ({ page }) => {
  await page.goto("#/workflow");
  await page.getByRole("button", { name: "新增角色" }).click();
  await page.getByRole("button", { name: "使用开发模板" }).click();
  await page.getByRole("button", { name: "选择节点 implement" }).click();
  await page.getByLabel("节点 implement 的角色").selectOption("developer");
  await page.getByRole("button", { name: "保存新版本" }).click();
  await expect(page.getByText("开发")).toBeVisible();
});
```

Use an e2e fixture with an `implement` Agent node; do not change unrelated test fixtures.

- [ ] **Step 4: Document the platform-owned model**

Add a README subsection: roles are created in the application and never loaded from imported project directories; binding a role and saving creates a new workflow version; existing Runs keep their stored definition and Agent prompt.

- [ ] **Step 5: Run final verification and commit**

Run: `npm.cmd run verify; npm.cmd run test:e2e:p1`

Expected: all packages and focused end-to-end workflow tests pass.

```bash
git add runtime/tests/test_api.py tests/e2e/workflow-p1.spec.ts README.md
git commit -m "test: cover role-aware workflow execution"
```

## Plan Self-Review

The tasks cover all approved requirements: platform-owned roles, canvas edit projection, node binding, compiler enforcement, prompt injection, version snapshots, no `.harness` dependency, compatibility for old no-role Agent nodes, and tests at every layer. Field names are consistent across the contracts, Runtime and renderer. `metadata.canvas.nodes` is the sole layout location, so layout cannot alter execution semantics. The plan contains concrete test code, implementation targets, commands and expected outcomes for every task.
