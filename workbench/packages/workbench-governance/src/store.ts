// Event-sourced + SQLite-persisted store for the governance plugin, with
// artifact governance (P2) and projection recovery (P3).
//
// Event sourcing discipline:
//   - `events` is the append-only source of truth (monotonic seq per run).
//   - `runs` + `nodes` are a PROJECTION, updated transactionally with each
//     event insert, so reads are O(1) and the log can always rebuild state.
//   - Every state change is one event; the projection never changes without
//     a matching event. `rebuildProjectionFromEvents` re-derives the projection
//     from the event stream alone.
//
// Artifact governance:
//   - Nodes declare delivery specs (id, project-relative path, required).
//   - `scanNodeArtifacts` scans, boundary-checks, hashes (SHA-256) and
//     versions artifacts (dedupe by hash).
//   - Missing REQUIRED artifacts keep the node AWAITING_ARTIFACT.
//   - `node.completed` binds the artifact hash set into the event detail;
//     `checkArtifacts` reports drift against that snapshot.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArtifactSpec {
  id: string;
  path: string;
  required: boolean;
}

export interface WorkflowNode {
  id: string;
  requiresApproval: boolean;
  artifacts: ArtifactSpec[];
  /** Optional bound role name (contract template). Fixed at template save. */
  role?: string;
  /** The role version the node was bound to at template-save time. */
  roleVersion?: number;
}

export interface WorkflowTemplate {
  name: string;
  version: number;
  nodes: Record<string, WorkflowNode>;
  firstNode: string;
}

/** One side of a role's artifact contract (input consumed or output produced). */
export interface RoleArtifact {
  id: string;
  path: string;
  required: boolean;
  /**
   * Optional content template for OUTPUT artifacts: a skeleton/spec the agent
   * should follow when producing the deliverable. Consumed by workflow_advance
   * (injected into the missing-artifact response) and snapshotted into the
   * evidence chain via the bound-role contract on node.completed. Lives on the
   * ROLE contract, never duplicated into bound nodes.
   */
  template?: string;
}

/**
 * A workflow role: the contract template a node binds to. Describes what the
 * role does, which upstream artifacts it accepts (inputs) and which artifacts
 * it produces (outputs). Nodes bind a role@version at template-save time so
 * later role edits never shift the evidence anchor of an already-bound node.
 */
export interface WorkflowRole {
  name: string;
  version: number;
  description: string;
  inputs: RoleArtifact[];
  outputs: RoleArtifact[];
}

export interface RunProjection {
  runId: string;
  workflow: string;
  status: "RUNNING" | "COMPLETED";
  current: string | null;
  projectDir: string;
  order: string[];
  nodes: Record<string, WorkflowNode>;
  startedAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  runId: string;
  actor: string;
  action: string;
  nodeId: string | null;
  detail: unknown;
}

export interface RunSummary {
  runId: string;
  workflow: string;
  status: string;
  current: string | null;
  startedAt: string;
  [key: string]: JsonValue;
}

/** JSON-compatible value (DSH tool outputs require lossless JSON). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ArtifactScanResult {
  artifact: string;
  path: string;
  required: boolean;
  status: "ok" | "missing" | "invalid-path";
  sha256?: string;
  size?: number;
  version?: number;
}

export interface ArtifactCheckResult extends ArtifactScanResult {
  recordedSha256: string | null;
  drift: "ok" | "drifted" | "missing" | "invalid-path" | "no-record";
}

export interface EventEntry {
  actor: string;
  action: string;
  nodeId?: string | null;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the store root: $WORKBENCH_STORE, else <cwd>/.workbench-poc/store. */
export function storeRoot(): string {
  const env = process.env.WORKBENCH_STORE;
  if (env !== undefined && env.trim().length > 0) return resolve(env);
  return resolve(join(process.cwd(), ".workbench-poc", "store"));
}

/** Resolve the project root for artifact paths: $WORKBENCH_PROJECT, else cwd. */
export function projectRoot(): string {
  const env = process.env.WORKBENCH_PROJECT;
  if (env !== undefined && env.trim().length > 0) return resolve(env);
  return resolve(process.cwd());
}

/**
 * Per-session project boundary: `<projectRoot>/sessions/<safeSessionId>`.
 * Used by workflow_start when the caller does not pass projectDir explicitly
 * but IS an agent (web/headless sessions): each conversation gets its own
 * artifact root so sessions never collide, while governance metadata stays
 * global. Returns null when the session id is unusable (non-string or
 * path-unsafe) so callers can fall back to the global project root.
 */
export function sessionProjectDir(sessionId: unknown): string | null {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return null;
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId === "." || sessionId === "..") return null;
  // Squeeze to a filesystem-safe token: keep [A-Za-z0-9._-], replace the rest.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (safe.length === 0) return null;
  return resolve(join(projectRoot(), "sessions", safe));
}

function dbPath(): string {
  return join(storeRoot(), "workbench.db");
}

function decisionPath(workflow: string, nodeId: string): string {
  return join(storeRoot(), "decisions", `${workflow}.${nodeId}.json`);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let db: DatabaseSync | null = null;

/** Singleton SQLite handle for this process. */
export function getDb(): DatabaseSync {
  if (db !== null) return db;
  mkdirSync(storeRoot(), { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec(`    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id       TEXT PRIMARY KEY,
      workflow     TEXT NOT NULL,
      status       TEXT NOT NULL,
      current_node TEXT,
      first_node   TEXT NOT NULL,
      project_dir  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      run_id            TEXT NOT NULL,
      node_id           TEXT NOT NULL,
      requires_approval INTEGER NOT NULL,
      position          INTEGER NOT NULL,
      artifacts         TEXT,
      role              TEXT,
      role_version      INTEGER,
      PRIMARY KEY (run_id, node_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      seq      INTEGER NOT NULL,
      run_id   TEXT NOT NULL,
      ts       TEXT NOT NULL,
      actor    TEXT NOT NULL,
      action   TEXT NOT NULL,
      node_id  TEXT,
      detail   TEXT,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      run_id        TEXT NOT NULL,
      node_id       TEXT NOT NULL,
      artifact_id   TEXT NOT NULL,
      version       INTEGER NOT NULL,
      path          TEXT NOT NULL,
      sha256        TEXT NOT NULL,
      size          INTEGER NOT NULL,
      registered_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, artifact_id, version)
    );
    -- Content snapshots for text artifacts, captured when a NEW version is
    -- registered (scanNodeArtifacts). Enables the workbench "产物" module to
    -- render and diff OLD versions even after the file on disk has changed or
    -- vanished. Binary/non-text artifacts get no snapshot (row absent).
    CREATE TABLE IF NOT EXISTS artifact_snapshots (
      run_id     TEXT NOT NULL,
      node_id    TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version    INTEGER NOT NULL,
      content    TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, artifact_id, version)
    );
    CREATE TABLE IF NOT EXISTS templates (
      name       TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      nodes      TEXT NOT NULL,
      first_node TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS template_audit (
      seq    INTEGER NOT NULL,
      name   TEXT NOT NULL,
      ts     TEXT NOT NULL,
      actor  TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (name, seq)
    );
    CREATE TABLE IF NOT EXISTS roles (
      name        TEXT PRIMARY KEY,
      version     INTEGER NOT NULL,
      description TEXT NOT NULL,
      inputs      TEXT NOT NULL,
      outputs     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_audit (
      seq    INTEGER NOT NULL,
      name   TEXT NOT NULL,
      ts     TEXT NOT NULL,
      actor  TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (name, seq)
    );
    -- Immutable version history of roles: every superseded version is archived
    -- here so nodes bound to a FIXED role version keep resolving the exact
    -- contract they were saved against (fixed-version evidence anchoring).
    CREATE TABLE IF NOT EXISTS role_versions (
      name        TEXT NOT NULL,
      version     INTEGER NOT NULL,
      description TEXT NOT NULL,
      inputs      TEXT NOT NULL,
      outputs     TEXT NOT NULL,
      saved_at    TEXT NOT NULL,
      PRIMARY KEY (name, version)
    );
  `);
  // Seed the built-in templates so workflow_start always has at least the
  // shipped definitions; the admin tools can add/update templates at runtime.
  for (const template of Object.values(WORKFLOW_TEMPLATES)) {
    db.prepare(
      "INSERT OR IGNORE INTO templates (name, version, nodes, first_node, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(template.name, 1, JSON.stringify(template.nodes), template.firstNode, new Date().toISOString(), new Date().toISOString());
  }
  // Seed the built-in roles (contract templates nodes can bind to).
  // INSERT OR IGNORE keeps admin edits, but seed upgrades (e.g. a template
  // added to a shipped role) must reach existing stores: refresh the seed
  // fields ONLY when the stored row still lacks them (never overwrite edits).
  for (const role of Object.values(WORKFLOW_ROLES)) {
    db.prepare(
      "INSERT OR IGNORE INTO roles (name, version, description, inputs, outputs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      role.name,
      1,
      role.description,
      JSON.stringify(role.inputs),
      JSON.stringify(role.outputs),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const existing = db.prepare("SELECT outputs FROM roles WHERE name = ?").get(role.name) as { outputs: string } | undefined;
    if (existing !== undefined) {
      const storedOutputs = JSON.parse(existing.outputs) as RoleArtifact[];
      const seedOutputs = role.outputs;
      // A stored output missing its seed template (older store) gets it now.
      let changed = false;
      const refreshed = storedOutputs.map((stored) => {
        const seed = seedOutputs.find((s) => s.id === stored.id);
        if (seed !== undefined && seed.template !== undefined && (stored.template === undefined || stored.template.trim().length === 0)) {
          changed = true;
          return { ...stored, template: seed.template };
        }
        return stored;
      });
      if (changed) {
        db.prepare("UPDATE roles SET outputs = ?, updated_at = ? WHERE name = ?").run(JSON.stringify(refreshed), new Date().toISOString(), role.name);
      }
    }
  }
  // Schema migration: older stores lack the nodes.role column. SQLite has no
  // IF NOT EXISTS for ALTER, so probe pragma_table_info and add when missing.
  const nodeCols = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
  if (!nodeCols.some((c) => c.name === "role")) {
    db.exec("ALTER TABLE nodes ADD COLUMN role TEXT");
  }
  if (!nodeCols.some((c) => c.name === "role_version")) {
    db.exec("ALTER TABLE nodes ADD COLUMN role_version INTEGER");
  }
  return db;
}

/** Close the singleton SQLite handle (tests/cleanup; next getDb() reopens). */
export function closeDb(): void {
  if (db !== null) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Workflow templates (admin-defined; agents cannot alter them)
// ---------------------------------------------------------------------------

export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  poc: {
    name: "poc",
    version: 1,
    nodes: {
      plan: {
        id: "plan",
        requiresApproval: true,
        artifacts: [{ id: "plan-doc", path: "artifacts/plan.md", required: true }],
      },
      verify: {
        id: "verify",
        requiresApproval: false,
        artifacts: [{ id: "verify-report", path: "artifacts/verify.md", required: true }],
      },
      ship: {
        id: "ship",
        requiresApproval: true,
        artifacts: [{ id: "ship-manifest", path: "artifacts/ship.json", required: true }],
      },
    },
    firstNode: "plan",
  },
  // --- AI-era full feature development (spec-first SDLC) --------------------
  sdlc: {
    name: "sdlc",
    version: 1,
    nodes: {
      spec: {
        id: "spec",
        requiresApproval: true,
        role: "spec-writer",
        artifacts: [{ id: "spec", path: "artifacts/spec.md", required: true }],
      },
      design: {
        id: "design",
        requiresApproval: true,
        role: "architect",
        artifacts: [{ id: "design", path: "artifacts/design.md", required: true }],
      },
      implement: {
        id: "implement",
        requiresApproval: false,
        role: "implementer",
        artifacts: [{ id: "changes", path: "artifacts/changes.md", required: true }],
      },
      review: {
        id: "review",
        requiresApproval: true,
        role: "reviewer",
        artifacts: [{ id: "review", path: "artifacts/review.md", required: true }],
      },
      test: {
        id: "test",
        requiresApproval: true,
        role: "tester",
        artifacts: [
          { id: "test-report", path: "artifacts/test-report.md", required: true },
          { id: "release", path: "artifacts/release.json", required: true },
        ],
      },
    },
    firstNode: "spec",
  },
  // --- hotfix: fast defect path (diagnose -> fix -> verify -> deploy) --------
  hotfix: {
    name: "hotfix",
    version: 1,
    nodes: {
      diagnose: {
        id: "diagnose",
        requiresApproval: false,
        role: "debugger",
        artifacts: [{ id: "patch", path: "artifacts/patch.md", required: true }],
      },
      verify: {
        id: "verify",
        requiresApproval: false,
        artifacts: [{ id: "verify-report", path: "artifacts/verify.md", required: true }],
      },
      deploy: {
        id: "deploy",
        requiresApproval: true,
        role: "shipper",
        artifacts: [{ id: "ship-manifest", path: "artifacts/ship.json", required: true }],
      },
    },
    firstNode: "diagnose",
  },
  // --- spike: research / prototype / recommendation (no release) ------------
  spike: {
    name: "spike",
    version: 1,
    nodes: {
      research: {
        id: "research",
        requiresApproval: false,
        role: "researcher",
        artifacts: [
          { id: "findings", path: "artifacts/findings.md", required: true },
          { id: "prototype", path: "artifacts/prototype.md", required: true },
        ],
      },
      recommend: {
        id: "recommend",
        requiresApproval: true,
        role: "researcher",
        artifacts: [{ id: "recommendation", path: "artifacts/recommendation.md", required: true }],
      },
    },
    firstNode: "research",
  },
};

// ---------------------------------------------------------------------------
// Workflow roles (contract templates; admin-defined, agents cannot alter them)
// ---------------------------------------------------------------------------

export const WORKFLOW_ROLES: Record<string, WorkflowRole> = {
  planner: {
    name: "planner",
    version: 1,
    description:
      "Plans the work: produces a plan document that later stages execute. " +
      "Consumes the task brief from upstream and outputs a concrete, reviewable plan.",
    inputs: [{ id: "brief", path: "artifacts/brief.md", required: true }],
    outputs: [
      {
        id: "plan-doc",
        path: "artifacts/plan.md",
        required: true,
        template:
          "# {title}\n\n## 目标\n- \n\n## 步骤\n1. \n\n## 验收\n- \n",
      },
    ],
  },
  verifier: {
    name: "verifier",
    version: 1,
    description:
      "Verifies deliverables: checks the plan was executed and produces a verification report. " +
      "Consumes the upstream plan and outputs evidence of verification.",
    inputs: [{ id: "plan-doc", path: "artifacts/plan.md", required: true }],
    outputs: [
      {
        id: "verify-report",
        path: "artifacts/verify.md",
        required: true,
        template: "# 验证报告\n\n## 检查项\n- [ ] \n\n## 结论\n- ",
      },
    ],
  },
  shipper: {
    name: "shipper",
    version: 1,
    description:
      "Ships the verified result: consumes the verification report and produces the release manifest.",
    inputs: [{ id: "verify-report", path: "artifacts/verify.md", required: true }],
    outputs: [
      {
        id: "ship-manifest",
        path: "artifacts/ship.json",
        required: true,
        template: '{\n  "version": "1.0.0",\n  "artifacts": [],\n  "checksum": ""\n}\n',
      },
    ],
  },
  // --- AI-era SDLC roles (spec-first) --------------------------------------
  "spec-writer": {
    name: "spec-writer",
    version: 1,
    description:
      "Writes the SPEC (spec-first SDLC): turns the task brief into a precise, testable " +
      "specification — scope, acceptance criteria, non-goals. The spec is the contract every " +
      "later stage implements against. Human-reviewed before design may start.",
    inputs: [{ id: "brief", path: "artifacts/brief.md", required: true }],
    outputs: [
      {
        id: "spec",
        path: "artifacts/spec.md",
        required: true,
        template: "# {title} — 规格\n\n## 背景\n- \n\n## 范围\n- 做：\n- 不做：\n\n## 验收标准\n- [ ] \n",
      },
    ],
  },
  architect: {
    name: "architect",
    version: 1,
    description:
      "Designs the technical solution from the approved spec: architecture, interfaces, data " +
      "model, risks. Human-reviewed before implementation starts.",
    inputs: [{ id: "spec", path: "artifacts/spec.md", required: true }],
    outputs: [
      {
        id: "design",
        path: "artifacts/design.md",
        required: true,
        template: "# {title} — 设计\n\n## 技术选型\n- \n\n## 模块/接口\n- \n\n## 数据模型\n- \n\n## 风险\n- \n",
      },
    ],
  },
  implementer: {
    name: "implementer",
    version: 1,
    description:
      "Implements the approved design against the spec: produces the change summary and diff " +
      "pointer. Automated (no approval) — quality is caught by the reviewer stage.",
    inputs: [{ id: "design", path: "artifacts/design.md", required: true }],
    outputs: [
      {
        id: "changes",
        path: "artifacts/changes.md",
        required: true,
        template: "# 变更清单\n\n## 改动文件\n- \n\n## 关键实现点\n- \n\n## 自测结果\n- [ ] \n",
      },
    ],
  },
  reviewer: {
    name: "reviewer",
    version: 1,
    description:
      "Reviews the implementation against the spec and design: correctness, coverage of " +
      "acceptance criteria, risks. Produces a review verdict. Human-reviewed before testing.",
    inputs: [{ id: "changes", path: "artifacts/changes.md", required: true }],
    outputs: [
      {
        id: "review",
        path: "artifacts/review.md",
        required: true,
        template: "# 评审结论\n\n## 对照验收标准\n- [ ] \n\n## 问题清单\n- \n\n## 结论\n- 通过 / 需返工\n",
      },
    ],
  },
  tester: {
    name: "tester",
    version: 1,
    description:
      "Tests the reviewed implementation: test report plus release manifest. The release " +
      "manifest is the final gate — human-approved before shipping.",
    inputs: [{ id: "review", path: "artifacts/review.md", required: true }],
    outputs: [
      {
        id: "test-report",
        path: "artifacts/test-report.md",
        required: true,
        template: "# 测试报告\n\n## 用例与结果\n- [ ] \n\n## 回归\n- [ ] \n\n## 结论\n- ",
      },
      {
        id: "release",
        path: "artifacts/release.json",
        required: true,
        template: '{\n  "version": "1.0.0",\n  "spec": "",\n  "review": "pass",\n  "tests": "pass"\n}\n',
      },
    ],
  },
  // --- hotfix role ----------------------------------------------------------
  debugger: {
    name: "debugger",
    version: 1,
    description:
      "Diagnoses an incident and produces the fix. Fast path: diagnosis is automated, the fix " +
      "is verified by the verify stage, and deployment needs human approval.",
    inputs: [{ id: "incident", path: "artifacts/incident.md", required: true }],
    outputs: [
      {
        id: "patch",
        path: "artifacts/patch.md",
        required: true,
        template: "# 修复说明\n\n## 根因\n- \n\n## 改动\n- \n\n## 影响面\n- \n",
      },
    ],
  },
  // --- spike role -----------------------------------------------------------
  researcher: {
    name: "researcher",
    version: 1,
    description:
      "Researches a technology or approach for a spike: produces findings, a prototype, and a " +
      "recommendation. The research question comes from the session (external input), so this " +
      "role declares NO required upstream inputs. The recommendation is human-reviewed; no release.",
    inputs: [],
    outputs: [
      {
        id: "findings",
        path: "artifacts/findings.md",
        required: true,
        template: "# 调研发现\n\n## 候选方案\n- \n\n## 对比\n| 方案 | 优点 | 缺点 |\n|---|---|---|\n| | | |\n",
      },
      {
        id: "prototype",
        path: "artifacts/prototype.md",
        required: true,
        template: "# 原型说明\n\n## 验证点\n- [ ] \n\n## 结果\n- ",
      },
      {
        id: "recommendation",
        path: "artifacts/recommendation.md",
        required: true,
        template: "# 建议\n\n## 结论\n- \n\n## 下一步\n- ",
      },
    ],
  },
};

/** Look up an admin-defined role by name from the runtime role store, or null. */
export function getRole(name: string): WorkflowRole | null {
  const database = getDb();
  const row = database.prepare("SELECT name, version, description, inputs, outputs FROM roles WHERE name = ?").get(name) as
    | { name: string; version: number; description: string; inputs: string; outputs: string }
    | undefined;
  if (row === undefined) return null;
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    inputs: JSON.parse(row.inputs) as RoleArtifact[],
    outputs: JSON.parse(row.outputs) as RoleArtifact[],
  };
}

/**
 * Resolve a role AT A SPECIFIC VERSION. The live `roles` table holds the
 * latest; superseded versions live in `role_versions`. This is what nodes
 * bound to a fixed role version resolve against — the contract never drifts
 * when the role is edited later. Falls back to the live row when the exact
 * version is the current one; returns null when the version is unknown.
 */
export function getRoleVersion(name: string, version: number): WorkflowRole | null {
  const database = getDb();
  const live = getRole(name);
  if (live !== null && live.version === version) return live;
  const row = database.prepare("SELECT name, version, description, inputs, outputs FROM role_versions WHERE name = ? AND version = ?").get(name, version) as
    | { name: string; version: number; description: string; inputs: string; outputs: string }
    | undefined;
  if (row === undefined) return null;
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    inputs: JSON.parse(row.inputs) as RoleArtifact[],
    outputs: JSON.parse(row.outputs) as RoleArtifact[],
  };
}

/** List all runtime-managed roles (name, version, input/output ids). */
export function listRoles(): Array<{ name: string; version: number; inputIds: string[]; outputIds: string[] }> {
  const database = getDb();
  return (database
    .prepare("SELECT name, version, inputs, outputs FROM roles ORDER BY name")
    .all() as Array<{ name: string; version: number; inputs: string; outputs: string }>)
    .map((row) => ({
      name: row.name,
      version: row.version,
      inputIds: (JSON.parse(row.inputs) as RoleArtifact[]).map((a) => a.id),
      outputIds: (JSON.parse(row.outputs) as RoleArtifact[]).map((a) => a.id),
    }));
}

/** List all runtime-managed roles as full contract documents (editable shape). */
export function listRoleDocuments(): WorkflowRole[] {
  const database = getDb();
  return (database
    .prepare("SELECT name, version, description, inputs, outputs FROM roles ORDER BY name")
    .all() as Array<{ name: string; version: number; description: string; inputs: string; outputs: string }>)
    .map((row) => ({
      name: row.name,
      version: row.version,
      description: row.description,
      inputs: JSON.parse(row.inputs) as RoleArtifact[],
      outputs: JSON.parse(row.outputs) as RoleArtifact[],
    }));
}

/**
 * Validate an admin-supplied role contract. Mirrors template validation:
 * non-empty unique artifact ids, non-empty paths, paths within the project.
 */
export function validateRoleInput(role: WorkflowRole): void {
  if (typeof role.name !== "string" || role.name.trim().length === 0) {
    throw new Error("role validation: name must be a non-empty string");
  }
  if (typeof role.description !== "string") {
    throw new Error(`role validation: "${role.name}" needs a description`);
  }
  for (const side of [role.inputs, role.outputs]) {
    if (!Array.isArray(side)) {
      throw new Error(`role validation: "${role.name}" inputs/outputs must be arrays`);
    }
    const ids = new Set<string>();
    for (const artifact of side) {
      if (typeof artifact.id !== "string" || artifact.id.trim().length === 0) {
        throw new Error(`role validation: "${role.name}" has an artifact without an id`);
      }
      if (ids.has(artifact.id)) {
        throw new Error(`role validation: "${role.name}" has duplicate artifact id "${artifact.id}"`);
      }
      ids.add(artifact.id);
      if (typeof artifact.path !== "string" || artifact.path.trim().length === 0) {
        throw new Error(`role validation: "${role.name}" artifact "${artifact.id}" has an empty path`);
      }
      if (resolveInProject(projectRoot(), artifact.path) === null) {
        throw new Error(`role validation: "${role.name}" artifact "${artifact.id}" path "${artifact.path}" escapes the project boundary`);
      }
    }
  }
}

/** Save (create or update) a runtime-managed role. Updates bump the version. */
export function saveRole(role: WorkflowRole): { role: WorkflowRole; created: boolean } {
  validateRoleInput(role);
  const database = getDb();
  const now = new Date().toISOString();
  const existing = database.prepare("SELECT version FROM roles WHERE name = ?").get(role.name) as { version: number } | undefined;
  const version = (existing?.version ?? 0) + 1;
  const normalized: WorkflowRole = {
    name: role.name,
    version,
    description: role.description,
    inputs: (role.inputs ?? []).map((a) => ({ id: a.id, path: a.path, required: Boolean(a.required) })),
    outputs: (role.outputs ?? []).map((a) => ({
      id: a.id,
      path: a.path,
      required: Boolean(a.required),
      ...(typeof a.template === "string" && a.template.trim().length > 0 ? { template: a.template } : {}),
    })),
  };
  if (existing === undefined) {
    database
      .prepare("INSERT INTO roles (name, version, description, inputs, outputs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(normalized.name, version, normalized.description, JSON.stringify(normalized.inputs), JSON.stringify(normalized.outputs), now, now);
  } else {
    // Archive the superseded version BEFORE overwriting, so nodes bound to
    // the fixed old version keep resolving their exact contract.
    const prev = getRole(role.name);
    if (prev !== null) {
      database
        .prepare("INSERT OR IGNORE INTO role_versions (name, version, description, inputs, outputs, saved_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(prev.name, prev.version, prev.description, JSON.stringify(prev.inputs), JSON.stringify(prev.outputs), now);
    }
    database
      .prepare("UPDATE roles SET version = ?, description = ?, inputs = ?, outputs = ?, updated_at = ? WHERE name = ?")
      .run(version, normalized.description, JSON.stringify(normalized.inputs), JSON.stringify(normalized.outputs), now, normalized.name);
  }
  return { role: normalized, created: existing === undefined };
}

/** Export a role as a portable, schema-tagged document. */
export function exportRole(name: string): { schema: string; role: WorkflowRole } | null {
  const role = getRole(name);
  if (role === null) return null;
  return { schema: "workbench-role/v1", role };
}

/** Import a portable role document under a target name. */
export function importRole(name: string, document: unknown): { role: WorkflowRole; created: boolean } {
  if (typeof document !== "object" || document === null) {
    throw new Error("role import: document must be an object");
  }
  const doc = document as { role?: unknown };
  if (typeof doc.role !== "object" || doc.role === null) {
    throw new Error("role import: document needs a role object");
  }
  const incoming = doc.role as Record<string, unknown>;
  return saveRole({
    name,
    description: typeof incoming.description === "string" ? incoming.description : "",
    inputs: Array.isArray(incoming.inputs) ? (incoming.inputs as RoleArtifact[]) : [],
    outputs: Array.isArray(incoming.outputs) ? (incoming.outputs as RoleArtifact[]) : [],
  } as WorkflowRole);
}

/** List project role files under `<project>/.workbench-roles/*.json`. */
export function listProjectRoleFiles(): string[] {
  const dir = join(projectRoot(), ".workbench-roles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

/** Read one project role file (boundary-checked). Name from document or basename. */
export function readProjectRoleFile(fileName: string): { name: string; document: unknown } {
  const abs = resolveInProject(projectRoot(), join(".workbench-roles", fileName));
  if (abs === null) {
    throw new Error(`project role file escapes the project boundary: ${fileName}`);
  }
  const document = JSON.parse(readUtf8(abs)) as { name?: unknown };
  const name = typeof document?.name === "string" && document.name.length > 0 ? document.name : fileName.replace(/\.json$/, "");
  return { name, document };
}

/** Append one role-audit entry (own monotonic seq per role name). */
export function appendRoleAudit(name: string, entry: EventEntry): { seq: number; ts: string; name: string; actor: string; action: string } {
  const database = getDb();
  const seqRow = database.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM role_audit WHERE name = ?").get(name) as { seq: number };
  const seq = seqRow.seq;
  const ts = new Date().toISOString();
  database
    .prepare("INSERT INTO role_audit (seq, name, ts, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(seq, name, ts, entry.actor, entry.action, entry.detail === undefined ? null : JSON.stringify(entry.detail));
  return { seq, ts, name, actor: entry.actor, action: entry.action };
}

/** Read a role's audit chain (oldest first). */
export function readRoleAudit(name: string): Array<{ seq: number; ts: string; actor: string; action: string; detail: unknown }> {
  const database = getDb();
  return (database
    .prepare("SELECT seq, ts, actor, action, detail FROM role_audit WHERE name = ? ORDER BY seq")
    .all(name) as Array<{ seq: number; ts: string; actor: string; action: string; detail: string | null }>)
    .map((row) => ({
      seq: row.seq,
      ts: row.ts,
      actor: row.actor,
      action: row.action,
      detail: row.detail === null || row.detail === undefined ? null : (JSON.parse(row.detail) as unknown),
    }));
}

/** Distinct role-audit subjects. */
export function listRoleAuditSubjects(): string[] {
  const database = getDb();
  return (database.prepare("SELECT DISTINCT name FROM role_audit ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

/**
 * The upstream gate for a node bound to a role: every REQUIRED input artifact
 * of the role must be registered by a PREVIOUS node in the run (i.e. already
 * produced upstream). The FIRST node of a run has no upstream by definition —
 * its role's required inputs are treated as external inputs supplied by the
 * session, so it never blocks on this gate. Returns the missing required
 * upstream artifacts for non-first nodes.
 */
export function checkRoleUpstream(runId: string, nodeId: string): RoleArtifact[] {
  const run = getRun(runId);
  if (run === null) throw new Error(`run not found: ${runId}`);
  const node = run.nodes[nodeId];
  if (node === undefined) throw new Error(`node not found: ${nodeId}`);
  const position = run.order.indexOf(nodeId);
  // First node: no upstream to check (external inputs).
  if (position <= 0) return [];
  const role = boundRoleForNode(runId, nodeId);
  if (role === null) return [];
  const requiredInputs = (role.inputs ?? []).filter((a) => a.required);
  if (requiredInputs.length === 0) return [];
  // Which artifact ids have been produced by EARLIER COMPLETED nodes? Only a
  // completed node's declared outputs count as available upstream — a node
  // that is merely declared (still RUNNING) has not produced anything yet.
  const events = readEvents(runId);
  const completed = new Set<string>();
  for (const event of events) {
    if (event.action === "node.completed" && event.nodeId !== null) completed.add(event.nodeId);
  }
  const produced = new Set<string>();
  for (const doneId of run.order.slice(0, position)) {
    if (!completed.has(doneId)) continue;
    for (const artifact of run.nodes[doneId]?.artifacts ?? []) {
      produced.add(artifact.id);
    }
  }
  return requiredInputs.filter((input) => !produced.has(input.id));
}

/**
 * Resolve the role contract bound to a node at its FIXED version (the version
 * the template was saved against). Used to snapshot the contract into
 * node.completed events and to inject the role description into the agent
 * context at advance time. Returns null when unbounded.
 */
export function boundRoleForNode(runId: string, nodeId: string): WorkflowRole | null {
  const run = getRun(runId);
  if (run === null) return null;
  const node = run.nodes[nodeId];
  if (node === undefined) return null;
  const roleName = (node as WorkflowNode & { role?: string }).role;
  if (roleName === undefined || roleName === null || roleName.trim().length === 0) return null;
  const roleVersion = (node as WorkflowNode & { roleVersion?: number }).roleVersion;
  // Fixed version: resolve against the archived version when the stored
  // version is not the live one — the bound contract never drifts with edits.
  if (typeof roleVersion === "number" && Number.isFinite(roleVersion)) {
    return getRoleVersion(roleName, roleVersion);
  }
  return getRole(roleName);
}

/**
 * Validate that a template node's declared artifacts match its bound role
 * contract: every declared artifact must be a known OUTPUT of the role
 * (the node may declare a subset — e.g. only the required outputs — but may
 * never invent artifacts the role does not produce). Throws on violation.
 */
export function validateNodeRoleBinding(node: WorkflowNode): void {
  const roleName = (node as WorkflowNode & { role?: string }).role;
  if (roleName === undefined || roleName === null || roleName.trim().length === 0) return;
  const role = getRole(roleName);
  if (role === null) throw new Error(`template validation: node "${node.id}" binds unknown role "${roleName}"`);
  const outputIds = new Set((role.outputs ?? []).map((a) => a.id));
  for (const artifact of node.artifacts ?? []) {
    if (!outputIds.has(artifact.id)) {
      throw new Error(
        `template validation: node "${node.id}" artifact "${artifact.id}" is not an output of role "${roleName}" ` +
          `(role outputs: ${[...outputIds].join(", ") || "(none)"})`,
      );
    }
  }
}

/**
 * Look up an admin-defined workflow template by name from the runtime
 * template store, or null when it does not exist.
 */
export function getWorkflowTemplate(name: string): WorkflowTemplate | null {
  const database = getDb();
  const row = database.prepare("SELECT name, version, nodes, first_node FROM templates WHERE name = ?").get(name) as
    | { name: string; version: number; nodes: string; first_node: string }
    | undefined;
  if (row === undefined) return null;
  return {
    name: row.name,
    version: row.version,
    nodes: JSON.parse(row.nodes) as Record<string, WorkflowNode>,
    firstNode: row.first_node,
  };
}

/** List all runtime-managed templates (name, version, node ids, first node). */
export function listTemplates(): Array<{ name: string; version: number; nodeIds: string[]; firstNode: string }> {
  const database = getDb();
  return (database
    .prepare("SELECT name, version, nodes, first_node FROM templates ORDER BY name")
    .all() as Array<{ name: string; version: number; nodes: string; first_node: string }>)
    .map((row) => ({
      name: row.name,
      version: row.version,
      nodeIds: Object.keys(JSON.parse(row.nodes) as Record<string, WorkflowNode>),
      firstNode: row.first_node,
    }));
}

/**
 * List all runtime-managed templates as full editable documents (schema-tagged,
 * same shape as exportTemplate). Used by the UI template-list page so it can
 * hand any template straight to the visual editor without a second fetch.
 */
export function listTemplateDocuments(): Array<{ schema: string; name: string; version: number; firstNode: string; nodes: WorkflowNode[] }> {
  const database = getDb();
  return (database
    .prepare("SELECT name, version, nodes, first_node FROM templates ORDER BY name")
    .all() as Array<{ name: string; version: number; nodes: string; first_node: string }>)
    .map((row) => ({
      schema: "workbench-template/v1",
      name: row.name,
      version: row.version,
      firstNode: row.first_node,
      nodes: Object.values(JSON.parse(row.nodes) as Record<string, WorkflowNode>),
    }));
}

/**
 * Validate an admin-supplied template definition. Throws a descriptive error
 * on any violation (duplicate/empty ids, unknown firstNode, artifact path
 * escaping the project boundary, duplicate artifact ids). Mirrors
 * ai-desktop's "save rejects invalid paths, duplicate IDs, unknown
 * references" rule.
 */
export function validateTemplateInput(nodes: WorkflowNode[], firstNode: string): void {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("template validation: nodes must be a non-empty array");
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.id.trim().length === 0) {
      throw new Error("template validation: every node needs a non-empty id");
    }
    if (ids.has(node.id)) {
      throw new Error(`template validation: duplicate node id "${node.id}"`);
    }
    ids.add(node.id);
    // Bound-role contract check: declared artifacts must be role outputs.
    validateNodeRoleBinding(node);
    const artifactIds = new Set<string>();
    for (const spec of node.artifacts ?? []) {
      if (typeof spec.id !== "string" || spec.id.trim().length === 0) {
        throw new Error(`template validation: node "${node.id}" has an artifact without an id`);
      }
      if (artifactIds.has(spec.id)) {
        throw new Error(`template validation: node "${node.id}" has duplicate artifact id "${spec.id}"`);
      }
      artifactIds.add(spec.id);
      if (typeof spec.path !== "string" || spec.path.trim().length === 0) {
        throw new Error(`template validation: artifact "${spec.id}" has an empty path`);
      }
      if (resolveInProject(projectRoot(), spec.path) === null) {
        throw new Error(`template validation: artifact "${spec.id}" path "${spec.path}" escapes the project boundary`);
      }
    }
  }
  if (typeof firstNode !== "string" || !ids.has(firstNode)) {
    throw new Error(`template validation: firstNode "${firstNode}" is not one of the node ids`);
  }
}

/**
 * Save (create or update) a runtime-managed template. Validation runs first
 * and throws on violation; updates bump the version and keep the created_at.
 * @returns the saved template plus whether it was newly created.
 */
export function saveTemplate(nodes: WorkflowNode[], firstNode: string, name: string): { template: WorkflowTemplate; created: boolean } {
  validateTemplateInput(nodes, firstNode);
  const database = getDb();
  const now = new Date().toISOString();
  const normalized: Record<string, WorkflowNode> = {};
  for (const node of nodes) {
    const roleName = typeof node.role === "string" && node.role.trim().length > 0 ? node.role : undefined;
    // Resolve the bound version: explicit roleVersion wins, else the role's
    // CURRENT version at save time (fixed snapshot from here on).
    let roleVersion: number | undefined = undefined;
    if (roleName !== undefined) {
      if (typeof node.roleVersion === "number" && Number.isFinite(node.roleVersion)) {
        roleVersion = node.roleVersion;
      } else {
        roleVersion = getRole(roleName)?.version;
      }
    }
    normalized[node.id] = {
      id: node.id,
      requiresApproval: Boolean(node.requiresApproval),
      artifacts: (node.artifacts ?? []).map((a) => ({ id: a.id, path: a.path, required: Boolean(a.required) })),
      // Preserve the bound role (fixed contract for this template version).
      ...(roleName !== undefined ? { role: roleName } : {}),
      ...(roleName !== undefined && roleVersion !== undefined ? { roleVersion } : {}),
    };
  }
  const existing = database.prepare("SELECT version FROM templates WHERE name = ?").get(name) as { version: number } | undefined;
  const version = (existing?.version ?? 0) + 1;
  const created = existing === undefined;
  if (created) {
    database
      .prepare("INSERT INTO templates (name, version, nodes, first_node, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, version, JSON.stringify(normalized), firstNode, now, now);
  } else {
    database
      .prepare("UPDATE templates SET version = ?, nodes = ?, first_node = ?, updated_at = ? WHERE name = ?")
      .run(version, JSON.stringify(normalized), firstNode, now, name);
  }
  return { template: { name, version, nodes: normalized, firstNode }, created };
}

/**
 * Export a template as a portable document (schema-tagged, self-contained)
 * for backup/migration/git-versioning. Read-only, no approval needed.
 */
export function exportTemplate(name: string): { schema: string; name: string; version: number; firstNode: string; nodes: WorkflowNode[] } | null {
  const template = getWorkflowTemplate(name);
  if (template === null) return null;
  return {
    schema: "workbench-template/v1",
    name: template.name,
    version: template.version,
    firstNode: template.firstNode,
    nodes: Object.keys(template.nodes).map((id) => template.nodes[id]),
  };
}

/**
 * Import a portable template document (as produced by exportTemplate, or any
 * equivalent shape). Validates the document shape and the node definitions
 * (throws on violation), then persists via saveTemplate.
 * @returns the saved template plus whether it was newly created.
 */
export function importTemplate(name: string, document: unknown): { template: WorkflowTemplate; created: boolean } {
  if (typeof document !== "object" || document === null) {
    throw new Error("template import: document must be an object");
  }
  const doc = document as { nodes?: unknown; firstNode?: unknown };
  if (!Array.isArray(doc.nodes) || typeof doc.firstNode !== "string") {
    throw new Error("template import: document needs a nodes array and a string firstNode");
  }
  // The document's own name is informational: importing under a different
  // target name is allowed (portable copy / versioned fork).
  return saveTemplate(doc.nodes as WorkflowNode[], doc.firstNode, name);
}

/**
 * List the project template files under `<project>/.workbench-templates/*.json`
 * (project boundary enforced). The convention mirrors ai-desktop's adapter
 * idea: workflows can live with the project as files and be synced into the
 * runtime template store.
 */
export function listProjectTemplateFiles(): string[] {
  const dir = join(projectRoot(), ".workbench-templates");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

/**
 * Read one project template file (boundary-checked). The template name comes
 * from the document's `name` field, falling back to the file basename.
 */
export function readProjectTemplateFile(fileName: string): { name: string; document: unknown } {
  const abs = resolveInProject(projectRoot(), join(".workbench-templates", fileName));
  if (abs === null) {
    throw new Error(`project template file escapes the project boundary: ${fileName}`);
  }
  const document = JSON.parse(readUtf8(abs)) as { name?: unknown };
  const name = typeof document?.name === "string" && document.name.length > 0 ? document.name : fileName.replace(/\.json$/, "");
  return { name, document };
}

/** Append one template-audit entry (own monotonic seq per template name). */
export function appendTemplateAudit(name: string, entry: EventEntry): { seq: number; ts: string; name: string; actor: string; action: string } {
  const database = getDb();
  const seqRow = database.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM template_audit WHERE name = ?").get(name) as { seq: number };
  const seq = seqRow.seq;
  const ts = new Date().toISOString();
  database
    .prepare("INSERT INTO template_audit (seq, name, ts, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(seq, name, ts, entry.actor, entry.action, entry.detail === undefined ? null : JSON.stringify(entry.detail));
  return { seq, ts, name, actor: entry.actor, action: entry.action };
}

/** Read a template's audit chain (oldest first). */
export function readTemplateAudit(name: string): Array<{ seq: number; ts: string; actor: string; action: string; detail: unknown }> {
  const database = getDb();
  return (database
    .prepare("SELECT seq, ts, actor, action, detail FROM template_audit WHERE name = ? ORDER BY seq")
    .all(name) as Array<{ seq: number; ts: string; actor: string; action: string; detail: string | null }>)
    .map((row) => ({
      seq: row.seq,
      ts: row.ts,
      actor: row.actor,
      action: row.action,
      detail: row.detail === null || row.detail === undefined ? null : (JSON.parse(row.detail) as unknown),
    }));
}

/** Distinct template-audit subjects (template names plus sync sentinels). */
export function listTemplateAuditSubjects(): string[] {
  const database = getDb();
  return (database.prepare("SELECT DISTINCT name FROM template_audit ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

/**
 * The approval inbox (mirrors ai-desktop's ApprovalInbox): every run currently
 * blocked at an approval or artifact gate, and every template change waiting on
 * a trusted-human decision. Read-only, derived from the event/audit streams.
 */
export function approvalInbox(): {
  runs: Array<{ runId: string; workflow: string; nodeId: string; blockedBy: "approval" | "artifact"; since: string }>;
  templates: Array<{ subject: string; action: string; since: string }>;
} {
  const runBlocks: Array<{ runId: string; workflow: string; nodeId: string; blockedBy: "approval" | "artifact"; since: string }> = [];
  for (const run of listRuns()) {
    if (run.status !== "RUNNING" || run.current === null) continue;
    const events = readEvents(run.runId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.nodeId !== run.current) continue;
      // approval.requested (web card open / unanswered) and approval.pending
      // (headless, no decision yet) both mean "waiting on a trusted human".
      if (event.action === "approval.pending" || event.action === "approval.requested") {
        runBlocks.push({ runId: run.runId, workflow: run.workflow, nodeId: run.current, blockedBy: "approval", since: event.ts });
        break;
      }
      if (event.action === "artifact.missing") {
        runBlocks.push({ runId: run.runId, workflow: run.workflow, nodeId: run.current, blockedBy: "artifact", since: event.ts });
        break;
      }
      // A resolved/advanced node (approved/rejected/completed) unblocks the gate.
      if (event.action === "node.approved" || event.action === "node.rejected" || event.action === "node.completed" || event.action === "run.completed") {
        break;
      }
    }
  }
  const templatePending: Array<{ subject: string; action: string; since: string }> = [];
  for (const subject of listTemplateAuditSubjects()) {
    const audit = readTemplateAudit(subject);
    const last = audit[audit.length - 1];
    // An unresolved request (save/import/sync.requested, e.g. while the web
    // approval card is open) or an explicit pending entry is "waiting".
    if (last !== undefined && (last.action.endsWith(".pending") || last.action.endsWith(".requested"))) {
      templatePending.push({ subject, action: last.action, since: last.ts });
    }
  }
  return { runs: runBlocks, templates: templatePending };
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/** Read a UTF-8 text file, stripping a leading BOM (see README: Windows BOM). */
function readUtf8(path: string): string {
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

interface RunRow {
  run_id: string;
  workflow: string;
  status: "RUNNING" | "COMPLETED";
  current_node: string | null;
  first_node: string;
  project_dir: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  node_id: string;
  requires_approval: number;
  artifacts: string | null;
  role: string | null;
  role_version: number | null;
}

/** Map a runs + nodes row set to the projected run document. */
function projectRun(runRow: RunRow | undefined, nodeRows: NodeRow[]): RunProjection | null {
  if (runRow === undefined) return null;
  const nodes: Record<string, WorkflowNode> = {};
  const order: string[] = [];
  for (const row of nodeRows) {
    nodes[row.node_id] = {
      id: row.node_id,
      requiresApproval: Boolean(row.requires_approval),
      artifacts: row.artifacts === null || row.artifacts === undefined ? [] : (JSON.parse(row.artifacts) as ArtifactSpec[]),
      ...(row.role !== null && row.role !== undefined && row.role !== "" ? { role: row.role } : {}),
      ...(row.role_version !== null && row.role_version !== undefined ? { roleVersion: row.role_version } : {}),
    };
    order.push(row.node_id);
  }
  return {
    runId: runRow.run_id,
    workflow: runRow.workflow,
    status: runRow.status,
    current: runRow.current_node,
    projectDir: runRow.project_dir,
    order,
    nodes,
    startedAt: runRow.created_at,
    updatedAt: runRow.updated_at,
  };
}

export interface CreateRunInput {
  runId: string;
  workflow: string;
  nodes: Record<string, WorkflowNode>;
  firstNode: string;
  projectDir?: string;
}

/**
 * Create a run from an admin template: inserts projection rows and the
 * run.started event in one transaction. Returns the projected run.
 */
export function createRun({ runId, workflow, nodes, firstNode, projectDir }: CreateRunInput): RunProjection {
  const database = getDb();
  const now = new Date().toISOString();
  const pinnedProject = projectDir ?? projectRoot();
  // A per-run projectDir is a session boundary: ensure the artifact root
  // exists so workflow_advance can write/scan artifacts inside it.
  if (projectDir !== undefined && projectDir.trim().length > 0) {
    mkdirSync(resolve(pinnedProject), { recursive: true });
  }
  database.exec("BEGIN");
  try {
    database
      .prepare("INSERT INTO runs (run_id, workflow, status, current_node, first_node, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, workflow, "RUNNING", firstNode, firstNode, pinnedProject, now, now);
    const insertNode = database.prepare(
      "INSERT INTO nodes (run_id, node_id, requires_approval, position, artifacts, role, role_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    Object.keys(nodes).forEach((id, position) => {
      insertNode.run(
        runId,
        id,
        nodes[id].requiresApproval ? 1 : 0,
        position,
        JSON.stringify(nodes[id].artifacts ?? []),
        nodes[id].role ?? null,
        nodes[id].roleVersion ?? null,
      );
    });
    insertEventInTx(
      database,
      runId,
      {
        actor: "system",
        action: "run.started",
        detail: {
          workflow,
          firstNode,
          projectDir: pinnedProject,
          // The full node definition is captured in the event so the projection
          // is rebuildable from the event stream alone (recovery/replay).
          nodes: Object.keys(nodes).map((id) => ({
            id,
            requiresApproval: nodes[id].requiresApproval,
            artifacts: nodes[id].artifacts ?? [],
            ...(nodes[id].role !== undefined && nodes[id].role !== null ? { role: nodes[id].role } : {}),
            ...(nodes[id].roleVersion !== undefined && nodes[id].roleVersion !== null ? { roleVersion: nodes[id].roleVersion } : {}),
          })),
        },
      },
      now,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getRun(runId) as RunProjection;
}

/** Load a run's projection, or null when it does not exist. */
export function getRun(runId: string): RunProjection | null {
  const database = getDb();
  const runRow = database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
  if (runRow === undefined) return null;
  const nodeRows = database
    .prepare("SELECT node_id, requires_approval, artifacts, role, role_version FROM nodes WHERE run_id = ? ORDER BY position")
    .all(runId) as unknown as NodeRow[];
  return projectRun(runRow, nodeRows);
}

/** List all runs (projection summary), newest first. */
export function listRuns(): RunSummary[] {
  const database = getDb();
  return (database
    .prepare("SELECT run_id, workflow, status, current_node, created_at FROM runs ORDER BY created_at DESC")
    .all() as Array<{ run_id: string; workflow: string; status: string; current_node: string | null; created_at: string }>)
    .map((row) => ({
      runId: row.run_id,
      workflow: row.workflow,
      status: row.status,
      current: row.current_node,
      startedAt: row.created_at,
    }));
}

/** Read the full event stream for a run, oldest first. */
export function readEvents(runId: string): AuditEvent[] {
  const database = getDb();
  return (database
    .prepare("SELECT seq, ts, actor, action, node_id, detail FROM events WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ seq: number; ts: string; actor: string; action: string; node_id: string | null; detail: string | null }>)
    .map((row) => ({
      seq: row.seq,
      ts: row.ts,
      runId,
      actor: row.actor,
      action: row.action,
      nodeId: row.node_id ?? null,
      // null (not undefined) — tool outputs must be lossless JSON
      detail: row.detail === null || row.detail === undefined ? null : (JSON.parse(row.detail) as unknown),
    }));
}

/**
 * Append one event and update the projection in the same transaction.
 * Supported projection effects:
 *   node.completed -> advance current to the next node, or COMPLETE the run
 *                     when the completed node was the last one;
 *   run.completed  -> force status COMPLETED;
 *   everything else (advance.attempted / approval.* / artifact.* / run.started)
 *   leaves the projection alone.
 */
export function appendEvent(runId: string, entry: EventEntry): AuditEvent {
  const database = getDb();
  database.exec("BEGIN");
  try {
    const record = insertEventInTx(database, runId, entry);
    applyProjection(database, runId, entry.action, entry.nodeId ?? null, record.ts);
    database.exec("COMMIT");
    return record;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Insert one event row (seq = next in run) inside an open transaction. */
function insertEventInTx(database: DatabaseSync, runId: string, entry: EventEntry, ts = new Date().toISOString()): AuditEvent {
  const seqRow = database.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number };
  const seq = seqRow.seq;
  const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail);
  database
    .prepare("INSERT INTO events (seq, run_id, ts, actor, action, node_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(seq, runId, ts, entry.actor, entry.action, entry.nodeId ?? null, detail);
  return { seq, ts, runId, actor: entry.actor, action: entry.action, nodeId: entry.nodeId ?? null, detail: entry.detail };
}

/** Apply the projection side-effect of one event inside an open transaction. */
function applyProjection(database: DatabaseSync, runId: string, action: string, nodeId: string | null, ts = new Date().toISOString()): void {
  if (action === "node.completed" && nodeId !== null && nodeId !== undefined) {
    const nodeRow = database.prepare("SELECT position FROM nodes WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as { position: number } | undefined;
    if (nodeRow !== undefined) {
      const next = database
        .prepare("SELECT node_id FROM nodes WHERE run_id = ? AND position = ?")
        .get(runId, nodeRow.position + 1) as { node_id: string } | undefined;
      if (next !== undefined) {
        database.prepare("UPDATE runs SET current_node = ?, updated_at = ? WHERE run_id = ?").run(next.node_id, ts, runId);
      } else {
        database.prepare("UPDATE runs SET status = 'COMPLETED', current_node = NULL, updated_at = ? WHERE run_id = ?").run(ts, runId);
      }
    }
  } else if (action === "run.completed") {
    database.prepare("UPDATE runs SET status = 'COMPLETED', updated_at = ? WHERE run_id = ?").run(ts, runId);
  }
}

// ---------------------------------------------------------------------------
// Artifact governance
// ---------------------------------------------------------------------------

/**
 * Resolve a project-relative artifact path and verify it stays INSIDE the
 * project boundary. Returns the absolute path, or null when the path escapes
 * the project (path-traversal guard).
 */
export function resolveInProject(projectDir: string, relPath: string): string | null {
  const root = resolve(projectDir);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

interface ArtifactRow {
  version: number;
  sha256: string;
}

/** Latest registered artifact version row for (run, node, artifact), or null. */
function latestArtifact(runId: string, nodeId: string, artifactId: string): ArtifactRow | undefined {
  const database = getDb();
  return database
    .prepare("SELECT version, sha256 FROM artifacts WHERE run_id = ? AND node_id = ? AND artifact_id = ? ORDER BY version DESC LIMIT 1")
    .get(runId, nodeId, artifactId) as ArtifactRow | undefined;
}

/**
 * Scan the declared artifacts of a node: boundary check, hash, version
 * registration (dedupe by hash). Does NOT gate anything itself — callers use
 * the returned statuses.
 */
export function scanNodeArtifacts(runId: string, nodeId: string): ArtifactScanResult[] {
  const run = getRun(runId);
  if (run === null) throw new Error(`run not found: ${runId}`);
  const node = run.nodes[nodeId];
  if (node === undefined) throw new Error(`node not found: ${nodeId}`);
  const results: ArtifactScanResult[] = [];
  for (const spec of node.artifacts ?? []) {
    const abs = resolveInProject(run.projectDir, spec.path);
    if (abs === null) {
      results.push({ artifact: spec.id, path: spec.path, required: Boolean(spec.required), status: "invalid-path" });
      continue;
    }
    if (!existsSync(abs)) {
      results.push({ artifact: spec.id, path: spec.path, required: Boolean(spec.required), status: "missing" });
      continue;
    }
    const content = readFileSync(abs);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const size = content.length;
    const latest = latestArtifact(runId, nodeId, spec.id);
    let version: number;
    if (latest !== undefined && latest.sha256 === sha256) {
      version = latest.version; // unchanged content: reuse the version
    } else {
      version = (latest?.version ?? 0) + 1;
      const database = getDb();
      database
        .prepare("INSERT INTO artifacts (run_id, node_id, artifact_id, version, path, sha256, size, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runId, nodeId, spec.id, version, spec.path, sha256, size, new Date().toISOString());
      // Snapshot text content so the workbench can render / diff old versions
      // even after the file on disk changes or disappears.
      if (isTextPath(spec.path) && content.length <= SNAPSHOT_MAX_BYTES) {
        database
          .prepare("INSERT INTO artifact_snapshots (run_id, node_id, artifact_id, version, content) VALUES (?, ?, ?, ?, ?)")
          .run(runId, nodeId, spec.id, version, content.toString("utf8"));
      }
    }
    results.push({ artifact: spec.id, path: spec.path, required: Boolean(spec.required), status: "ok", sha256, size, version });
  }
  return results;
}

interface RecordedArtifact {
  artifactId: string;
  path: string;
  sha256: string;
  version: number;
}

/**
 * Re-validate a node's artifacts against the hash snapshot recorded at
 * `node.completed` (the evidence anchor). Reports per artifact:
 *   status ok + drift "ok" | "drifted" | "no-record", or status missing/invalid-path.
 */
export function checkArtifacts(runId: string, nodeId: string): ArtifactCheckResult[] {
  const events = readEvents(runId);
  const completion = events.find((e) => e.action === "node.completed" && e.nodeId === nodeId);
  const recorded = (completion?.detail as { artifacts?: RecordedArtifact[] } | null)?.artifacts ?? [];
  return scanNodeArtifacts(runId, nodeId).map((current) => {
    const rec = recorded.find((r) => r.artifactId === current.artifact);
    if (current.status !== "ok") {
      return { ...current, recordedSha256: rec?.sha256 ?? null, drift: current.status };
    }
    if (rec === undefined) return { ...current, recordedSha256: null, drift: "no-record" };
    return { ...current, recordedSha256: rec.sha256, drift: rec.sha256 === current.sha256 ? "ok" : "drifted" };
  });
}

// ---------------------------------------------------------------------------
// Recovery / replay
// ---------------------------------------------------------------------------
/**
 * Rebuild a run's projection from its event stream alone (recovery/replay).
 * The projection rows for the run are wiped, then re-derived: run.started
 * recreates the run + node rows from its captured detail (workflow, firstNode,
 * projectDir, nodes), and every later event re-applies its projection effect
 * with its own timestamp, so the rebuilt projection is byte-identical.
 * @returns the rebuilt projection, or null when the run has no run.started.
 */
export function rebuildProjectionFromEvents(runId: string): RunProjection | null {
  const database = getDb();
  const events = readEvents(runId);
  const started = events.find((e) => e.action === "run.started");
  if (started === undefined) return null;
  const detail = started.detail as { workflow: string; firstNode: string; projectDir: string; nodes: WorkflowNode[] };
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    database.prepare("DELETE FROM nodes WHERE run_id = ?").run(runId);
    database
      .prepare("INSERT INTO runs (run_id, workflow, status, current_node, first_node, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, detail.workflow, "RUNNING", detail.firstNode, detail.firstNode, detail.projectDir, started.ts, started.ts);
    const insertNode = database.prepare(
      "INSERT INTO nodes (run_id, node_id, requires_approval, position, artifacts, role, role_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    (detail.nodes ?? []).forEach((node, position) => {
      insertNode.run(runId, node.id, node.requiresApproval ? 1 : 0, position, JSON.stringify(node.artifacts ?? []), node.role ?? null, node.roleVersion ?? null);
    });
    for (const event of events) {
      if (event.action === "run.started") continue;
      applyProjection(database, runId, event.action, event.nodeId, event.ts);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getRun(runId);
}

// ---------------------------------------------------------------------------
// Evidence package (mirrors ai-desktop's Evidence: tamper-evident run snapshot)
// ---------------------------------------------------------------------------

/** All artifact versions registered for a run, oldest first. */
export function readArtifactsForRun(runId: string): Array<{
  nodeId: string;
  artifactId: string;
  version: number;
  path: string;
  sha256: string;
  size: number;
  registeredAt: string;
}> {
  const database = getDb();
  return (database
    .prepare("SELECT node_id, artifact_id, version, path, sha256, size, registered_at FROM artifacts WHERE run_id = ? ORDER BY version, node_id, artifact_id")
    .all(runId) as Array<{ node_id: string; artifact_id: string; version: number; path: string; sha256: string; size: number; registered_at: string }>)
    .map((row) => ({
      nodeId: row.node_id,
      artifactId: row.artifact_id,
      version: row.version,
      path: row.path,
      sha256: row.sha256,
      size: row.size,
      registeredAt: row.registered_at,
    }));
}

/**
 * Build a tamper-evident evidence package for a run: the full event stream,
 * every registered artifact version, and a per-event hash chain where entry N
 * hashes entry N-1 plus the event content — any later edit breaks the chain.
 * @returns the package document, or null when the run does not exist.
 */
export function buildEvidencePackage(runId: string): Record<string, unknown> | null {
  const run = getRun(runId);
  if (run === null) return null;
  const events = readEvents(runId);
  const artifacts = readArtifactsForRun(runId);
  let previous = "";
  const hashChain = events.map((event) => {
    const content = JSON.stringify({
      seq: event.seq,
      ts: event.ts,
      actor: event.actor,
      action: event.action,
      nodeId: event.nodeId,
      detail: event.detail,
    });
    const hash = createHash("sha256").update(previous + "|" + content).digest("hex");
    previous = hash;
    return { seq: event.seq, hash };
  });
  const body = {
    schema: "workbench-evidence/v1",
    runId,
    workflow: run.workflow,
    status: run.status,
    current: run.current,
    exportedAt: new Date().toISOString(),
    events,
    artifacts,
    hashChain,
  };
  const packageHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, packageHash };
}

/**
 * Write a run's evidence package to `<project>/.workbench-evidence/<runId>.json`
 * (project boundary enforced), so evidence lives with the project and can be
 * git-versioned. @returns {path, packageHash} or null when the run is unknown.
 */
export function writeEvidencePackage(runId: string): { path: string; packageHash: string } | null {
  const pkg = buildEvidencePackage(runId);
  if (pkg === null) return null;
  const run = getRun(runId);
  if (run === null) return null;
  // Run ids are opaque identifiers generated by workflow_start; reject anything
  // that could smuggle path separators into the evidence file name.
  if (runId.includes("/") || runId.includes("\\") || runId === "." || runId === "..") {
    throw new Error(`invalid runId for evidence file: ${runId}`);
  }
  const relative = join(".workbench-evidence", `${runId}.json`);
  // Resolve against the run's own project boundary (each run may bind a
  // different projectDir) so evidence stays with the artifacts it anchors.
  const absolute = resolveInProject(run.projectDir, relative);
  if (absolute === null) {
    throw new Error(`evidence path escapes the project boundary: ${relative}`);
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(pkg, null, 2), "utf8");
  return { path: relative, packageHash: pkg.packageHash as string };
}

// ---------------------------------------------------------------------------
// Trusted-human decisions (headless fallback)
// ---------------------------------------------------------------------------

export interface HumanDecision {
  decision: "approve" | "reject";
  actor?: string;
  note?: string;
}

/**
 * Read the trusted-human decision for (workflow, nodeId), or null when no
 * decision has been recorded. A decision file is expected to look like:
 *   { "decision": "approve" | "reject", "actor": "trusted-human", "note": "..." }
 */
export function readDecision(workflow: string, nodeId: string): HumanDecision | null {
  const path = decisionPath(workflow, nodeId);
  if (!existsSync(path)) return null;
  return JSON.parse(readUtf8(path)) as HumanDecision;
}

// ---------------------------------------------------------------------------
// Artifact catalog & content access (workbench "产物" module)
// ---------------------------------------------------------------------------

/** Text extensions that get content snapshots and inline rendering. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
  ".py", ".sh", ".bash", ".ps1", ".sql", ".csv", ".xml", ".log", ".java", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".svg",
]);

/** Image extensions previewed inline in the browser. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Byte cap for text snapshots stored in SQLite. */
const SNAPSHOT_MAX_BYTES = 512 * 1024;
/** Char cap for content delivered to the browser (protects the UI). */
const CONTENT_MAX_CHARS = 300_000;
/** Byte cap for inline base64 image previews. */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function fileExtension(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx < 0) return "";
  const ext = path.slice(idx).toLowerCase();
  return ext.length <= 8 ? ext : "";
}

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(fileExtension(path));
}

/** Browser-friendly MIME for an artifact path. */
export function mimeForPath(path: string): string {
  const ext = fileExtension(path);
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    case ".csv":
      return "text/csv";
    case ".xml":
      return "text/xml";
    default:
      return isTextPath(path) ? "text/plain" : "application/octet-stream";
  }
}

export interface ArtifactCatalogEntry {
  runId: string;
  workflow: string;
  runStatus: string;
  nodeId: string;
  artifactId: string;
  path: string;
  version: number;
  versions: number;
  sha256: string;
  size: number;
  registeredAt: string;
  exists: boolean;
  invalidPath: boolean;
  currentSha256: string | null;
  currentSize: number | null;
  drifted: boolean;
}

/**
 * Cross-run artifact catalog: the LATEST registered version of every
 * (run, node, artifact), annotated with the current on-disk state so the
 * workbench list can flag missing / drifted artifacts without opening them.
 */
export function listAllArtifacts(): ArtifactCatalogEntry[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT a.run_id, a.node_id, a.artifact_id, a.version, a.path, a.sha256, a.size, a.registered_at,
              r.workflow, r.status AS run_status, r.project_dir
       FROM artifacts a
       JOIN runs r ON r.run_id = a.run_id
       WHERE a.version = (
         SELECT MAX(a2.version) FROM artifacts a2
         WHERE a2.run_id = a.run_id AND a2.node_id = a.node_id AND a2.artifact_id = a.artifact_id
       )
       ORDER BY a.registered_at DESC`,
    )
    .all() as Array<{
    run_id: string;
    node_id: string;
    artifact_id: string;
    version: number;
    path: string;
    sha256: string;
    size: number;
    registered_at: string;
    workflow: string;
    run_status: string;
    project_dir: string;
  }>;
  const versionCounts = database
    .prepare(
      "SELECT run_id, node_id, artifact_id, COUNT(*) AS n FROM artifacts GROUP BY run_id, node_id, artifact_id",
    )
    .all() as Array<{ run_id: string; node_id: string; artifact_id: string; n: number }>;
  const countKey = (r: string, n: string, a: string) => `${r}\u0000${n}\u0000${a}`;
  const counts = new Map(versionCounts.map((c) => [countKey(c.run_id, c.node_id, c.artifact_id), c.n]));

  return rows.map((row) => {
    const abs = resolveInProject(row.project_dir, row.path);
    let exists = false;
    let currentSha256: string | null = null;
    let currentSize: number | null = null;
    let invalidPath = false;
    if (abs === null) {
      invalidPath = true;
    } else if (existsSync(abs)) {
      exists = true;
      const disk = readFileSync(abs);
      currentSha256 = createHash("sha256").update(disk).digest("hex");
      currentSize = disk.length;
    }
    return {
      runId: row.run_id,
      workflow: row.workflow,
      runStatus: row.run_status,
      nodeId: row.node_id,
      artifactId: row.artifact_id,
      path: row.path,
      version: row.version,
      versions: counts.get(countKey(row.run_id, row.node_id, row.artifact_id)) ?? 1,
      sha256: row.sha256,
      size: row.size,
      registeredAt: row.registered_at,
      exists,
      invalidPath,
      currentSha256,
      currentSize,
      drifted: exists && currentSha256 !== row.sha256,
    };
  });
}

export interface ArtifactVersionMeta {
  version: number;
  sha256: string;
  size: number;
  registeredAt: string;
  hasSnapshot: boolean;
}

export interface ArtifactContentView {
  status: "ok" | "missing" | "invalid-path" | "not-found";
  kind: "view";
  runId: string;
  nodeId: string;
  artifactId: string;
  path: string;
  version: number;
  versions: ArtifactVersionMeta[];
  mime: string;
  binary: boolean;
  contentEncoding: "utf8" | "base64" | null;
  content: string | null;
  truncated: boolean;
  registeredSha256: string;
  currentSha256: string | null;
  currentSize: number | null;
  drifted: boolean;
}

export interface ArtifactContentDiff {
  status: "ok" | "missing" | "invalid-path" | "not-found" | "no-snapshot";
  kind: "diff";
  runId: string;
  nodeId: string;
  artifactId: string;
  path: string;
  from: { version: number; content: string | null; truncated: boolean };
  to: { version: number; content: string | null; truncated: boolean };
}

/** Registered versions of one (run, node, artifact), oldest first. */
function versionsOf(runId: string, nodeId: string, artifactId: string): ArtifactVersionMeta[] {
  const database = getDb();
  return (database
    .prepare(
      "SELECT version, sha256, size, registered_at FROM artifacts WHERE run_id = ? AND node_id = ? AND artifact_id = ? ORDER BY version",
    )
    .all(runId, nodeId, artifactId) as Array<{ version: number; sha256: string; size: number; registered_at: string }>)
    .map((row) => ({
      version: row.version,
      sha256: row.sha256,
      size: row.size,
      registeredAt: row.registered_at,
      hasSnapshot: hasSnapshot(runId, nodeId, artifactId, row.version),
    }));
}

function hasSnapshot(runId: string, nodeId: string, artifactId: string, version: number): boolean {
  const database = getDb();
  return (
    database
      .prepare("SELECT 1 AS one FROM artifact_snapshots WHERE run_id = ? AND node_id = ? AND artifact_id = ? AND version = ?")
      .get(runId, nodeId, artifactId, version) !== undefined
  );
}

function readSnapshot(runId: string, nodeId: string, artifactId: string, version: number): string | null {
  const database = getDb();
  const row = database
    .prepare("SELECT content FROM artifact_snapshots WHERE run_id = ? AND node_id = ? AND artifact_id = ? AND version = ?")
    .get(runId, nodeId, artifactId, version) as { content: string } | undefined;
  return row === undefined ? null : row.content;
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Resolve the node spec for (run, node, artifact), or null. */
function artifactSpecOf(runId: string, nodeId: string, artifactId: string): { path: string } | null {
  const run = getRun(runId);
  if (run === null) return null;
  const node = run.nodes[nodeId];
  if (node === undefined) return null;
  const spec = (node.artifacts ?? []).find((a) => a.id === artifactId);
  return spec === undefined ? null : { path: spec.path };
}

/**
 * Read one artifact for the browser: metadata + content (text inline, images
 * as base64, binary without content). When `against` is given, returns the
 * two-version diff payload instead (for DiffBlock).
 */
export function readArtifactContent(args: {
  runId: string;
  nodeId: string;
  artifactId: string;
  version?: number;
  against?: number;
}): ArtifactContentView | ArtifactContentDiff {
  const { runId, nodeId, artifactId } = args;
  const spec = artifactSpecOf(runId, nodeId, artifactId);
  if (spec === null) {
    return { status: "not-found", kind: "view", runId, nodeId, artifactId, path: "", version: 0, versions: [], mime: "text/plain", binary: false, contentEncoding: null, content: null, truncated: false, registeredSha256: "", currentSha256: null, currentSize: null, drifted: false };
  }
  const run = getRun(runId);
  if (run === null) {
    return { status: "not-found", kind: "view", runId, nodeId, artifactId, path: spec.path, version: 0, versions: [], mime: "text/plain", binary: false, contentEncoding: null, content: null, truncated: false, registeredSha256: "", currentSha256: null, currentSize: null, drifted: false };
  }
  const abs = resolveInProject(run.projectDir, spec.path);
  if (abs === null) {
    return { status: "invalid-path", kind: "view", runId, nodeId, artifactId, path: spec.path, version: 0, versions: [], mime: "text/plain", binary: false, contentEncoding: null, content: null, truncated: false, registeredSha256: "", currentSha256: null, currentSize: null, drifted: false };
  }
  const versions = versionsOf(runId, nodeId, artifactId);
  const latest = versions.length > 0 ? versions[versions.length - 1] : null;
  if (latest === null) {
    return { status: "not-found", kind: "view", runId, nodeId, artifactId, path: spec.path, version: 0, versions: [], mime: "text/plain", binary: false, contentEncoding: null, content: null, truncated: false, registeredSha256: "", currentSha256: null, currentSize: null, drifted: false };
  }

  const ext = fileExtension(spec.path);
  const isText = isTextPath(spec.path);
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const mime = mimeForPath(spec.path);

  // Current disk state (the "live" side).
  let diskContent: Buffer | null = null;
  let currentSha256: string | null = null;
  let currentSize: number | null = null;
  if (existsSync(abs)) {
    diskContent = readFileSync(abs);
    currentSha256 = createHash("sha256").update(diskContent).digest("hex");
    currentSize = diskContent.length;
  }

  // Diff mode: resolve two registered versions (snapshot first, disk fallback
  // only for the LATEST version — an older version has no disk identity).
  if (args.against !== undefined && args.version !== undefined) {
    const fromV = versions.find((v) => v.version === args.against);
    const toV = versions.find((v) => v.version === args.version);
    if (fromV === undefined || toV === undefined) {
      return { status: "not-found", kind: "diff", runId, nodeId, artifactId, path: spec.path, from: { version: args.against, content: null, truncated: false }, to: { version: args.version, content: null, truncated: false } };
    }
    const resolveSide = (v: ArtifactVersionMeta, latestV: boolean): { content: string | null; truncated: boolean } => {
      if (!isText) return { content: null, truncated: false };
      const snap = readSnapshot(runId, nodeId, artifactId, v.version);
      if (snap !== null) {
        const t = truncateText(snap, CONTENT_MAX_CHARS);
        return { content: t.text, truncated: t.truncated };
      }
      if (latestV && diskContent !== null) {
        const t = truncateText(diskContent.toString("utf8"), CONTENT_MAX_CHARS);
        return { content: t.text, truncated: t.truncated };
      }
      return { content: null, truncated: false };
    };
    const from = resolveSide(fromV, fromV.version === latest.version);
    const to = resolveSide(toV, toV.version === latest.version);
    const missingSide = (from.content === null && isText) || (to.content === null && isText);
    return {
      status: isText ? (missingSide ? "no-snapshot" : "ok") : "no-snapshot",
      kind: "diff",
      runId,
      nodeId,
      artifactId,
      path: spec.path,
      from: { version: fromV.version, ...from },
      to: { version: toV.version, ...to },
    };
  }

  // View mode.
  const requestedVersion = args.version ?? latest.version;
  const meta = versions.find((v) => v.version === requestedVersion);
  if (meta === undefined) {
    return { status: "not-found", kind: "view", runId, nodeId, artifactId, path: spec.path, version: requestedVersion, versions, mime, binary: !isText, contentEncoding: null, content: null, truncated: false, registeredSha256: "", currentSha256, currentSize, drifted: currentSha256 !== null && latest.sha256 !== currentSha256 };
  }

  let content: string | null = null;
  let contentEncoding: "utf8" | "base64" | null = null;
  let truncated = false;
  const isLatest = meta.version === latest.version;
  if (isText) {
    const snap = readSnapshot(runId, nodeId, artifactId, meta.version);
    if (snap !== null) {
      const t = truncateText(snap, CONTENT_MAX_CHARS);
      content = t.text;
      truncated = t.truncated;
    } else if (isLatest && diskContent !== null) {
      const t = truncateText(diskContent.toString("utf8"), CONTENT_MAX_CHARS);
      content = t.text;
      truncated = t.truncated;
    }
    contentEncoding = "utf8";
  } else if (isLatest && diskContent !== null && diskContent.length <= IMAGE_MAX_BYTES) {
    // Images (and any small binary) are delivered base64 so the browser can
    // preview / download them; large binaries get metadata only.
    content = diskContent.toString("base64");
    contentEncoding = "base64";
  }

  return {
    status: "ok",
    kind: "view",
    runId,
    nodeId,
    artifactId,
    path: spec.path,
    version: meta.version,
    versions,
    mime,
    binary: !isText,
    contentEncoding,
    content,
    truncated,
    registeredSha256: meta.sha256,
    currentSha256,
    currentSize,
    drifted: currentSha256 !== null && meta.sha256 !== currentSha256,
  };
}

export interface RunDetail {
  run: RunProjection;
  artifacts: Array<{
    nodeId: string;
    artifactId: string;
    version: number;
    path: string;
    sha256: string;
    size: number;
    registeredAt: string;
  }>;
  events: AuditEvent[];
}

/** Full detail for one run: projection + registered artifacts + event stream. */
export function readRunDetail(runId: string): RunDetail | null {
  const run = getRun(runId);
  if (run === null) return null;
  return { run, artifacts: readArtifactsForRun(runId), events: readEvents(runId) };
}
