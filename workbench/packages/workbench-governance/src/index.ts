// governance plugin: a DSH Cordis plugin proving the governance thesis —
// a workflow plugin can HARD-BLOCK the agent loop at an approval gate, and
// only a trusted human decision unblocks it. Every transition and approval
// is appended to an event-sourced audit chain persisted in SQLite.
//
// Tools registered:
//   workflow_start   — create a governed run from an admin-defined template
//   workflow_advance — try to advance the current node; artifact + approval
//                      gates hard-block until requirements are satisfied
//   workflow_audit   — read the run projection plus the full event stream
//   workflow_check   — re-validate artifacts against the completion snapshot
//
// Approval resolution order:
//   1. `ctx.userQuestions` (the DSH UI seam, mounted by the Web app): the tool
//      genuinely PAUSES the agent loop until the human answers — only enabled
//      when WORKBENCH_UI_APPROVAL=1 (web profile); headless skips this so the
//      automation never hangs on an absent UI provider.
//   2. Headless fallback: a decision file under the store, written by the
//      "trusted human" outside the agent loop. If the file is absent the node
//      stays AWAITING_APPROVAL.
//
// Known limitation (documented in README): in headless mode the decision file
// is on the same filesystem the agent can reach, so a capable agent could forge
// it. The UI seam path (web) is the non-forgeable one; the file path exists
// only to make the mechanism automatable without a human in the loop.

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  appendEvent,
  appendRoleAudit,
  appendTemplateAudit,
  approvalInbox,
  boundRoleForNode,
  buildEvidencePackage,
  checkArtifacts,
  checkRoleUpstream,
  createRun,
  exportRole,
  exportTemplate,
  getRole,
  getRun,
  getWorkflowTemplate,
  importRole,
  importTemplate,
  listProjectRoleFiles,
  listProjectTemplateFiles,
  listRoleAuditSubjects,
  listRoleDocuments,
  listRoles,
  listRuns,
  listTemplateDocuments,
  listTemplates,
  listAllArtifacts,
  readArtifactContent,
  readProjectRoleFile,
  readProjectTemplateFile,
  readDecision,
  readEvents,
  readRoleAudit,
  readRunDetail,
  saveRole,
  saveTemplate,
  scanNodeArtifacts,
  sessionProjectDir,
  validateRoleInput,
  validateTemplateInput,
  writeEvidencePackage,
  type ArtifactCheckResult,
  type ArtifactScanResult,
  type EventEntry,
  type HumanDecision,
  type RoleArtifact,
  type RunProjection,
  type WorkflowNode,
  type WorkflowRole,
} from "./store.js";

const name = "governance-poc";
const inject = ["tools"];

const USER_QUESTION_NO_PROVIDER = "NO_PROVIDER";

type ApprovalResolution =
  | { pending: true }
  | { pending?: false; decision: "approve" | "reject"; actor: string; note?: string };

/** Shared JSON renderer for tool output blocks. */
function textRender(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** JSON-compatible value (DSH tool outputs require lossless JSON). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** "poc, qa" — live list of known workflow templates for tool descriptions. */
function knownTemplateNames(): string {
  return listTemplates().map((t) => t.name).join(", ");
}

/**
 * Resolve the content template for one output artifact of a run node's bound
 * role (role outputs carry an optional template). Returns null when the node
 * has no role, the artifact id is not a role output, or the role declares no
 * template for it. Used to inject the template into the missing-artifact
 * response so the agent can produce the deliverable to spec.
 */
function roleOutputTemplate(runId: string, nodeId: string, artifactId: string): string | null {
  const role = boundRoleForNode(runId, nodeId);
  if (role === null) return null;
  const output = (role.outputs ?? []).find((a) => a.id === artifactId);
  if (output === undefined) return null;
  return typeof output.template === "string" && output.template.trim().length > 0 ? output.template : null;
}

/**
 * Tool outputs must be lossless JSON (`{...} & Record<string, JsonValue>` per
 * the DSH ToolDefinition contract). Round-tripping through JSON both satisfies
 * the type boundary and guarantees the emitted value is JSON-safe at runtime,
 * while preserving the declared shape (required keys like runId stay known).
 */
function jsonOut<T extends Record<string, unknown>>(value: T): T & Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as T & Record<string, JsonValue>;
}

/**
 * Resolve the trusted-human decision for (workflow, nodeId).
 * Returns { decision, actor } when decided, or { pending: true } when the
 * human has not decided yet.
 */
async function resolveApproval(
  ctx: any,
  exec: { signal?: AbortSignal; agent?: unknown },
  workflow: string,
  nodeId: string,
): Promise<ApprovalResolution> {
  // Path 1: the DSH UI seam (web). ask() blocks until the human answers.
  // Only attempted when WORKBENCH_UI_APPROVAL=1 (the web profile sets it);
  // headless demos skip straight to the trusted-human decision file so the
  // automation is deterministic and cannot hang on an absent UI provider.
  const userQuestions = ctx.get("userQuestions");
  if (userQuestions !== undefined && process.env.WORKBENCH_UI_APPROVAL === "1") {
    try {
      const answer = await userQuestions.ask({
        questions: [
          {
            id: `approve-${workflow}-${nodeId}`,
            question: `是否批准推进工作流 "${workflow}" 的节点 "${nodeId}"？`,
            header: "工作流审批",
            options: [
              { label: "批准", description: "允许推进该节点并继续工作流" },
              { label: "拒绝", description: "阻止推进，节点保持阻塞" },
            ],
          },
        ],
        // Mirror the harness's own ask_user_question tool: the web UI provider
        // requires the interaction to belong to an agent-owned session, so the
        // live calling agent must be passed through (ASK_MISSING_AGENT otherwise).
        ...exec.agent !== void 0 ? { agent: exec.agent } : {},
        signal: exec.signal,
      });
      const selected = answer?.answers?.[0]?.selected?.[0];
      if (selected === "拒绝") {
        return { decision: "reject", actor: "ui-human" };
      }
      return { decision: "approve", actor: "ui-human" };
    } catch (error) {
      if ((error as { code?: string })?.code !== USER_QUESTION_NO_PROVIDER) throw error;
      // No UI provider (headless): fall through to the file path.
    }
  }

  // Path 2: trusted-human decision file (headless automation only).
  const fileDecision: HumanDecision | null = readDecision(workflow, nodeId);
  if (fileDecision === null) return { pending: true };
  if (fileDecision.decision !== "approve" && fileDecision.decision !== "reject") {
    throw new Error(
      `invalid decision file for ${workflow}.${nodeId}: ${JSON.stringify(fileDecision)}`,
    );
  }
  return {
    decision: fileDecision.decision,
    actor: fileDecision.actor ?? "trusted-human",
    note: fileDecision.note,
  };
}

/** JSON-safe run map for the visual tool card (engine-side, reliable). */
function runMap(run: RunProjection): Record<string, JsonValue> {
  return JSON.parse(
    JSON.stringify({
      workflow: run.workflow,
      status: run.status,
      current: run.current,
      nodes: run.order.map((id) => run.nodes[id]),
    }),
  ) as Record<string, JsonValue>;
}

function apply(ctx: any): void {
  // ---- workflow_start -------------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_start",
    description:
      "Create a governed workflow run from an ADMIN-DEFINED workflow template. " +
      "Workflows are fixed by the workbench admin: you (the agent) cannot alter " +
      "their nodes or approval requirements. Known templates: " +
      `${knownTemplateNames() || "(none yet — run workflow_template_list)"}. ` +
      "Each template's nodes are advanced one at a time with workflow_advance; " +
      "use workflow_audit to read the audit chain.",
    parameters: {
      workflow: {
        type: "string",
        description:
          "Name of the admin-defined workflow template. " +
          `Known templates: ${knownTemplateNames() || "(none)"}. ` +
          "When omitted, the WORKBENCH_DEFAULT_WORKFLOW environment variable " +
          "(set on the workbench profile) selects the default workflow.",
      },
      projectDir: {
        type: "string",
        description:
          "Optional project root for this run's artifacts (absolute path). " +
          "When omitted, the run binds to THIS SESSION's own project boundary " +
          "(derived from the calling session id as <WORKBENCH_PROJECT>/sessions/<sessionId>) " +
          "so concurrent conversations never collide on artifact files. " +
          "Governance metadata (events, approvals, audit) stays global regardless. " +
          "Only when there is no calling agent does it fall back to the global WORKBENCH_PROJECT.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", required: true },
          runId: { type: "string", required: true },
          workflow: { type: "string", required: true },
          current: { type: "string", required: true },
          nodes: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                requiresApproval: { type: "boolean", required: true },
                role: { type: "string", description: "Optional bound role name." },
                roleVersion: { type: "number", description: "Fixed role version the node was bound to." },
                artifacts: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      id: { type: "string", required: true },
                      path: { type: "string", required: true },
                      required: { type: "boolean", required: true },
                    },
                  },
                },
              },
            },
          },
          map: { type: "object", required: true, additionalProperties: true, description: "Engine-driven run map for the visual card." },
        },
      },
      render: textRender,
    },
    async execute(args: { workflow?: string; projectDir?: string }, exec: { signal?: AbortSignal; agent?: { id?: unknown } }) {
      const workflow = args.workflow ?? process.env.WORKBENCH_DEFAULT_WORKFLOW;
      if (workflow === undefined || workflow.trim().length === 0) {
        const known = listTemplates().map((t) => t.name).join(", ");
        throw new Error(
          `no workflow template selected — pass workflow=<name> or set WORKBENCH_DEFAULT_WORKFLOW. Known templates: ${known || "(none)"}`,
        );
      }
      const template = getWorkflowTemplate(workflow);
      if (template === null) {
        throw new Error(
          `unknown workflow template "${workflow}" — known templates: ${listTemplates().map((t) => t.name).join(", ")}`,
        );
      }
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // projectDir resolution order:
      //   1. explicit argument (agent-chosen / caller-chosen boundary)
      //   2. per-session derivation from the calling agent's session id, so
      //      every conversation gets its own artifact root automatically
      //   3. global project root (WORKBENCH_PROJECT / cwd) — legacy behavior
      const explicitDir = args.projectDir !== undefined && args.projectDir.trim().length > 0 ? args.projectDir : undefined;
      const projectDir =
        explicitDir ??
        (exec.agent !== void 0 && exec.agent !== null && typeof exec.agent === "object"
          ? sessionProjectDir((exec.agent as { id?: unknown }).id)
          : null) ??
        undefined;
      const run = createRun({
        runId,
        workflow: template.name,
        nodes: template.nodes,
        firstNode: template.firstNode,
        projectDir,
      });
      return jsonOut({
        status: "STARTED",
        runId,
        workflow: run.workflow,
        current: run.current ?? template.firstNode,
        nodes: run.order.map((id) => run.nodes[id]),
        map: runMap(run),
      });
    },
  }));

  // ---- workflow_advance ------------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_advance",
    description:
      "Try to advance the CURRENT node of a run. Two hard gates apply in order: " +
      "(1) ARTIFACT gate — every required artifact of the node must exist inside the project; " +
      "otherwise the tool returns AWAITING_ARTIFACT and the node is NOT completed. " +
      "(2) APPROVAL gate — nodes that require approval return AWAITING_APPROVAL (or REJECTED after " +
      "a human rejection) and are NOT completed until a trusted human approves. " +
      "You cannot complete a gated node by any other means.",
    parameters: {
      runId: { type: "string", required: true, description: "Run id from workflow_start." },
      nodeId: { type: "string", required: true, description: "The node id that must equal the run's current node." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          runId: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { runId: string; nodeId: string }, exec: { signal?: AbortSignal; agent?: unknown }) {
      const run = getRun(args.runId);
      if (run === null) throw new Error(`run not found: ${args.runId}`);
      if (run.status === "COMPLETED") {
        return jsonOut({ status: "ALREADY_COMPLETED", runId: args.runId, map: runMap(run) });
      }
      if (run.current !== args.nodeId) {
        return jsonOut({
          status: "NOT_CURRENT",
          runId: args.runId,
          nodeId: args.nodeId,
          current: run.current,
          map: runMap(run),
        });
      }
      const node = run.nodes[args.nodeId];
      if (node === undefined) throw new Error(`node not found: ${args.nodeId}`);

      // Every attempt is recorded, even the blocked ones.
      appendEvent(args.runId, { actor: "agent", action: "advance.attempted", nodeId: args.nodeId });

      // ROLE UPSTREAM GATE: a node bound to a role must be able to consume its
      // role's REQUIRED inputs from previously completed (upstream) nodes. This
      // hard-blocks BEFORE the artifact gate — a node whose upstream contract
      // is unsatisfied can neither be approved nor completed.
      const missingUpstream = checkRoleUpstream(args.runId, args.nodeId);
      if (missingUpstream.length > 0) {
        appendEvent(args.runId, {
          actor: "agent",
          action: "upstream.missing",
          nodeId: args.nodeId,
          detail: { artifacts: missingUpstream },
        });
        return jsonOut({
          status: "AWAITING_UPSTREAM",
          runId: args.runId,
          nodeId: args.nodeId,
          missing: missingUpstream.map((a) => ({ artifact: a.id, path: a.path })),
          note: "role-required upstream artifacts have not been produced by a previous node; the node is not completed",
          map: { ...runMap(run), blockedBy: "upstream" },
        });
      }

      // ARTIFACT GATE: scan declared deliverables first. Missing REQUIRED
      // artifacts keep the node AWAITING_ARTIFACT — an approval cannot be
      // reached, let alone granted, for a node whose deliverable is absent.
      const artifactScan: ArtifactScanResult[] = scanNodeArtifacts(args.runId, args.nodeId);
      const invalidPaths = artifactScan.filter((a) => a.status === "invalid-path");
      if (invalidPaths.length > 0) {
        appendEvent(args.runId, {
          actor: "system",
          action: "artifact.invalid-path",
          nodeId: args.nodeId,
          detail: { artifacts: invalidPaths },
        });
        throw new Error(`artifact path escapes the project boundary: ${invalidPaths.map((a) => a.path).join(", ")}`);
      }
      const missingRequired = artifactScan.filter((a) => a.status === "missing" && a.required);
      if (missingRequired.length > 0) {
        // Attach each missing artifact's role output template (when the node
        // binds a role that declares one) so the agent can produce the
        // deliverable to spec instead of guessing its shape.
        const missingWithTemplates = missingRequired.map((a) => ({
          artifact: a.artifact,
          path: a.path,
          ...(roleOutputTemplate(args.runId, args.nodeId, a.artifact) !== null
            ? { template: roleOutputTemplate(args.runId, args.nodeId, a.artifact) }
            : {}),
        }));
        appendEvent(args.runId, {
          actor: "agent",
          action: "artifact.missing",
          nodeId: args.nodeId,
          detail: { artifacts: missingWithTemplates },
        });
        return jsonOut({
          status: "AWAITING_ARTIFACT",
          runId: args.runId,
          nodeId: args.nodeId,
          missing: missingWithTemplates,
          note: "required artifacts are missing; the node is not completed",
          map: { ...runMap(run), blockedBy: "artifact" },
        });
      }
      const registeredArtifacts = artifactScan.filter((a) => a.status === "ok");
      for (const artifact of registeredArtifacts) {
        appendEvent(args.runId, {
          actor: "system",
          action: "artifact.registered",
          nodeId: args.nodeId,
          detail: { artifact: artifact.artifact, path: artifact.path, sha256: artifact.sha256, version: artifact.version },
        });
      }

      // APPROVAL GATE: approval-required nodes cannot be completed by the agent.
      if (node.requiresApproval) {
        // Record the request BEFORE asking, so a web-mode approval card that is
        // still open (or a session switch) leaves a visible "waiting" entry in
        // the approval inbox instead of vanishing until the human answers.
        appendEvent(args.runId, {
          actor: "agent",
          action: "approval.requested",
          nodeId: args.nodeId,
        });
        let approval: ApprovalResolution;
        try {
          approval = await resolveApproval(ctx, exec, run.workflow, args.nodeId);
        } catch (error) {
          // Record the real failure into the event stream so headless demos can
          // diagnose why the gate did not resolve, then surface it to the agent.
          const message = error instanceof Error ? error.message : String(error);
          appendEvent(args.runId, {
            actor: "system",
            action: "advance.error",
            nodeId: args.nodeId,
            detail: { message, code: (error as { code?: string })?.code },
          });
          throw error;
        }
        if (approval.pending) {
          appendEvent(args.runId, {
            actor: "agent",
            action: "approval.pending",
            nodeId: args.nodeId,
          });
          return jsonOut({
            status: "AWAITING_APPROVAL",
            runId: args.runId,
            nodeId: args.nodeId,
            workflow: run.workflow,
            note: "human approval required; the node is not completed",
            map: { ...runMap(run), blockedBy: "approval" },
          });
        }
        if (approval.decision === "reject") {
          appendEvent(args.runId, {
            actor: approval.actor,
            action: "node.rejected",
            nodeId: args.nodeId,
            detail: { decision: "reject", note: approval.note },
          });
          return jsonOut({
            status: "REJECTED",
            runId: args.runId,
            nodeId: args.nodeId,
            note: "trusted human rejected advancement; the node stays blocked",
            map: { ...runMap(run), blockedBy: "rejected" },
          });
        }
        appendEvent(args.runId, {
          actor: approval.actor,
          action: "node.approved",
          nodeId: args.nodeId,
          detail: { decision: "approve", note: approval.note },
        });
      }

      // Complete the node; the projection advances (or completes) here. The
      // artifact hash set is bound into the completion event as the evidence
      // anchor — later content changes can be detected against it. If the node
      // binds a role, the role contract (description + input/output lists) is
      // SNAPSHOTTED here too, so later role edits can never rewrite what this
      // node was bound to (fixed-version evidence anchoring).
      const boundRole = boundRoleForNode(args.runId, args.nodeId);
      appendEvent(args.runId, {
        actor: "system",
        action: "node.completed",
        nodeId: args.nodeId,
        detail: {
          artifacts: registeredArtifacts.map((a) => ({
            artifactId: a.artifact,
            path: a.path,
            sha256: a.sha256,
            version: a.version,
          })),
          ...(boundRole !== null
            ? {
                role: {
                  name: boundRole.name,
                  version: boundRole.version,
                  description: boundRole.description,
                  inputs: boundRole.inputs,
                  outputs: boundRole.outputs,
                },
              }
            : {}),
        },
      });
      const fresh = getRun(args.runId);
      if (fresh !== null && fresh.status === "COMPLETED") {
        appendEvent(args.runId, { actor: "system", action: "run.completed" });
        return jsonOut({ status: "COMPLETED", runId: args.runId, nodeId: args.nodeId, current: null, map: runMap(fresh) });
      }
      return jsonOut({
        status: "ADVANCED",
        runId: args.runId,
        nodeId: args.nodeId,
        current: fresh?.current ?? null,
        map: fresh !== null ? runMap(fresh) : null,
      });
    },
  }));

  // ---- workflow_audit --------------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_audit",
    description:
      "Read the current projection of a run (status, current node) plus its full " +
      "event-sourced audit stream (sequence, timestamp, actor, action, nodeId, detail).",
    parameters: {
      runId: { type: "string", required: true, description: "Run id from workflow_start." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          runId: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { runId: string }) {
      const run: RunProjection | null = getRun(args.runId);
      const entries = readEvents(args.runId);
      return jsonOut({
        runId: args.runId,
        run: run
          ? { workflow: run.workflow, current: run.current, status: run.status, nodes: run.order.map((id) => run.nodes[id]) }
          : null,
        entries,
      });
    },
  }));

  // ---- workflow_check ------------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_check",
    description:
      "Re-validate the artifacts of a node against the hash snapshot recorded when the node " +
      "completed (the evidence anchor). Reports per artifact: ok/drifted/missing/invalid-path. " +
      "A drifted artifact means the deliverable changed after the node was approved+completed — " +
      "stale approvals/evidence can no longer be trusted. Records an artifact.checked event.",
    parameters: {
      runId: { type: "string", required: true, description: "Run id from workflow_start." },
      nodeId: { type: "string", required: true, description: "A node id of the run." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          runId: { type: "string", required: true },
          nodeId: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { runId: string; nodeId: string }) {
      const results: ArtifactCheckResult[] = checkArtifacts(args.runId, args.nodeId);
      const entry: EventEntry = {
        actor: "system",
        action: "artifact.checked",
        nodeId: args.nodeId,
        detail: { artifacts: results },
      };
      appendEvent(args.runId, entry);
      return jsonOut({ runId: args.runId, nodeId: args.nodeId, artifacts: results });
    },
  }));

  // ---- workflow_template_save -----------------------------------------
  // Workflow definitions are ADMIN-managed: saving/updating a template is
  // gated by the SAME trusted-human approval seam as node advancement, so an
  // agent can never redefine governance by itself.
  ctx.tools.register(defineTool({
    name: "workflow_template_save",
    description:
      "Create or update an ADMIN-DEFINED workflow template in the runtime template store. " +
      "This is a governance action: the change is hard-blocked until a trusted human approves it " +
      "(AWAITING_APPROVAL / REJECTED otherwise). Input is validated first — duplicate node/artifact ids, " +
      "unknown firstNode, or artifact paths escaping the project boundary are rejected without saving. " +
      "Returns the saved template (name, version, firstNode, nodes) and whether it was newly created.",
    parameters: {
      name: { type: "string", required: true, description: "Unique template name, e.g. 'qa'." },
      firstNode: { type: "string", required: true, description: "Id of the first node to run." },
      nodes: {
        type: "array",
        required: true,
        description: "Ordered node definitions.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true, description: "Stable unique node id." },
            requiresApproval: {
              type: "boolean",
              required: true,
              description: "Whether this node hard-blocks until a trusted human approves it.",
            },
            role: {
              type: "string",
              description: "Optional bound role name — the node then inherits the role contract (its declared artifacts must be role outputs).",
            },
            roleVersion: {
              type: "number",
              description: "Optional fixed role version. When omitted, the role's current version at save time is bound.",
            },
            artifacts: {
              type: "array",
              required: true,
              description: "Declared deliverables (project-relative paths).",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  path: { type: "string", required: true },
                  required: { type: "boolean", required: true },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { name: string; firstNode: string; nodes: WorkflowNode[] }, exec: { signal?: AbortSignal; agent?: unknown }) {
      const { name, firstNode, nodes } = args;
      appendTemplateAudit(name, {
        actor: "agent",
        action: "template.save.requested",
        detail: { nodeIds: nodes.map((n) => n.id), firstNode },
      });
      // Validation first: invalid definitions never reach the approval gate.
      try {
        validateTemplateInput(nodes, firstNode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTemplateAudit(name, { actor: "system", action: "template.save.invalid", detail: { message } });
        throw error;
      }
      // Governance gate: only a trusted human can change workflow definitions.
      let approval: ApprovalResolution;
      try {
        approval = await resolveApproval(ctx, exec, "__templates__", name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTemplateAudit(name, { actor: "system", action: "template.save.error", detail: { message } });
        throw error;
      }
      if (approval.pending) {
        appendTemplateAudit(name, { actor: "agent", action: "template.save.pending" });
        return jsonOut({
          status: "AWAITING_APPROVAL",
          name,
          note: "trusted-human approval required; the template was NOT saved",
        });
      }
      if (approval.decision === "reject") {
        appendTemplateAudit(name, { actor: approval.actor, action: "template.save.rejected" });
        return jsonOut({
          status: "REJECTED",
          name,
          note: "trusted human rejected the template change; nothing was saved",
        });
      }
      const saved = saveTemplate(nodes, firstNode, name);
      appendTemplateAudit(name, {
        actor: approval.actor,
        action: saved.created ? "template.created" : "template.updated",
        detail: { version: saved.template.version, firstNode, nodeIds: Object.keys(saved.template.nodes) },
      });
      return jsonOut({
        status: "SAVED",
        name,
        created: saved.created,
        version: saved.template.version,
        firstNode: saved.template.firstNode,
        nodes: Object.keys(saved.template.nodes).map((id) => saved.template.nodes[id]),
      });
    },
  }));

  // ---- workflow_template_list ------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_template_list",
    description:
      "List the runtime-managed workflow templates (name, version, node ids, first node). " +
      "Use workflow_template_save to add or update a template (trusted-human gated).",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          templates: { type: "array", required: true },
        },
      },
      render: textRender,
    },
    async execute() {
      return jsonOut({ templates: listTemplates() });
    },
  }));

  // ---- workflow_editor ---------------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_editor",
    description:
      "Open the visual workflow editor for a template (or a blank canvas when no name is given). " +
      "The editor card lets a trusted human arrange nodes, toggle approval requirements, configure " +
      "artifacts, and SAVE the template back to the runtime store (saves are audited with actor " +
      "ui-editor). This is a HUMAN editing surface — agents only open it, they cannot save through it.",
    parameters: {
      name: { type: "string", description: "Template name to edit; omit for a new blank workflow." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          editable: { type: "boolean", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { name?: string }) {
      const doc = typeof args.name === "string" && args.name.length > 0 ? exportTemplate(args.name) : null;
      return jsonOut({
        editable: true,
        template: doc,
      });
    },
  }));

  // ---- workflow_template_export ----------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_template_export",
    description:
      "Export a runtime template as a portable, self-contained document " +
      "(schema-tagged: name, version, firstNode, nodes) for backup, migration or " +
      "git-versioning. Read-only — no approval needed. Use workflow_template_import " +
      "to restore the document under a template name (trusted-human gated).",
    parameters: {
      name: { type: "string", required: true, description: "Template name to export." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          schema: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { name: string }) {
      const doc = exportTemplate(args.name);
      if (doc === null) {
        throw new Error(`unknown workflow template "${args.name}" — known templates: ${listTemplates().map((t) => t.name).join(", ")}`);
      }
      return jsonOut(doc);
    },
  }));

  // ---- workflow_template_import ----------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_template_import",
    description:
      "Import a portable template document (as produced by workflow_template_export) under a " +
      "template name. This is a governance action: the import is hard-blocked until a trusted " +
      "human approves it (AWAITING_APPROVAL / REJECTED otherwise). The document is validated " +
      "first — malformed shape, duplicate/empty ids, unknown firstNode or artifact paths escaping " +
      "the project boundary are rejected without saving.",
    parameters: {
      name: { type: "string", required: true, description: "Target template name for the import." },
      document: {
        type: "object",
        required: true,
        additionalProperties: true,
        description: "The portable template document (schema, name, version, firstNode, nodes).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { name: string; document: unknown }, exec: { signal?: AbortSignal; agent?: unknown }) {
      const { name } = args;
      appendTemplateAudit(name, {
        actor: "agent",
        action: "template.import.requested",
        detail: { sourceName: (args.document as { name?: unknown } | null)?.name ?? null },
      });
      // Validation first (shape + node rules) WITHOUT saving — importTemplate
      // persists, so the gated save must happen exactly once, after approval.
      try {
        const doc = args.document as { nodes?: unknown; firstNode?: unknown };
        if (typeof doc !== "object" || doc === null || !Array.isArray(doc.nodes) || typeof doc.firstNode !== "string") {
          throw new Error("template import: document needs a nodes array and a string firstNode");
        }
        validateTemplateInput(doc.nodes as WorkflowNode[], doc.firstNode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTemplateAudit(name, { actor: "system", action: "template.import.invalid", detail: { message } });
        throw error;
      }
      // Governance gate: only a trusted human can change workflow definitions.
      let approval: ApprovalResolution;
      try {
        approval = await resolveApproval(ctx, exec, "__templates__", name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTemplateAudit(name, { actor: "system", action: "template.import.error", detail: { message } });
        throw error;
      }
      if (approval.pending) {
        appendTemplateAudit(name, { actor: "agent", action: "template.import.pending" });
        return jsonOut({
          status: "AWAITING_APPROVAL",
          name,
          note: "trusted-human approval required; the template was NOT imported",
        });
      }
      if (approval.decision === "reject") {
        appendTemplateAudit(name, { actor: approval.actor, action: "template.import.rejected" });
        return jsonOut({
          status: "REJECTED",
          name,
          note: "trusted human rejected the template import; nothing was saved",
        });
      }
      const imported = importTemplate(name, args.document);
      appendTemplateAudit(name, {
        actor: approval.actor,
        action: imported.created ? "template.imported" : "template.imported.updated",
        detail: { version: imported.template.version, firstNode: imported.template.firstNode, nodeIds: Object.keys(imported.template.nodes) },
      });
      return jsonOut({
        status: "IMPORTED",
        name,
        created: imported.created,
        version: imported.template.version,
        firstNode: imported.template.firstNode,
        nodes: Object.keys(imported.template.nodes).map((id) => imported.template.nodes[id]),
      });
    },
  }));

  // ---- workflow_template_sync_project -----------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_template_sync_project",
    description:
      "Sync workflow templates FROM the project into the runtime template store. " +
      "Reads every `.workbench-templates/*.json` file in the project (the template name comes from " +
      "the document's `name` field, falling back to the file basename). This is a governance action: " +
      "the whole sync is hard-blocked until a trusted human approves it. Files that fail to parse or " +
      "validate are reported WITHOUT being saved, and block the sync. Returns the imported templates.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(_args: Record<string, never>, exec: { signal?: AbortSignal; agent?: unknown }) {
      const files = listProjectTemplateFiles();
      if (files.length === 0) {
        return jsonOut({ status: "NO_FILES", note: "no .workbench-templates/*.json files in the project" });
      }
      // Parse + validate every file first; any failure blocks the whole sync.
      const prepared: Array<{ fileName: string; name: string; document: unknown }> = [];
      const errors: Array<{ fileName: string; message: string }> = [];
      for (const fileName of files) {
        try {
          const { name, document } = readProjectTemplateFile(fileName);
          const doc = document as { nodes?: unknown; firstNode?: unknown };
          if (typeof doc !== "object" || doc === null || !Array.isArray(doc.nodes) || typeof doc.firstNode !== "string") {
            throw new Error("document needs a nodes array and a string firstNode");
          }
          validateTemplateInput(doc.nodes as WorkflowNode[], doc.firstNode);
          prepared.push({ fileName, name, document });
        } catch (error) {
          errors.push({ fileName, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (errors.length > 0) {
        appendTemplateAudit("__sync__", { actor: "system", action: "template.sync.invalid", detail: { errors } });
        return jsonOut({ status: "INVALID", files, errors, note: "invalid project template files; nothing was imported" });
      }
      // Governance gate: one trusted-human decision for the whole sync.
      let approval: ApprovalResolution;
      try {
        approval = await resolveApproval(ctx, exec, "__templates__", "__sync__");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTemplateAudit("__sync__", { actor: "system", action: "template.sync.error", detail: { message } });
        throw error;
      }
      if (approval.pending) {
        appendTemplateAudit("__sync__", { actor: "agent", action: "template.sync.pending" });
        return jsonOut({ status: "AWAITING_APPROVAL", files, note: "trusted-human approval required; nothing was imported" });
      }
      if (approval.decision === "reject") {
        appendTemplateAudit("__sync__", { actor: approval.actor, action: "template.sync.rejected" });
        return jsonOut({ status: "REJECTED", files, note: "trusted human rejected the sync; nothing was imported" });
      }
      const imported = prepared.map(({ fileName, name, document }) => {
        const result = importTemplate(name, document);
        appendTemplateAudit(name, {
          actor: approval.actor,
          action: result.created ? "template.synced" : "template.synced.updated",
          detail: { fileName, version: result.template.version },
        });
        return { fileName, name, created: result.created, version: result.template.version };
      });
      appendTemplateAudit("__sync__", {
        actor: approval.actor,
        action: "template.sync.completed",
        detail: { files: imported },
      });
      return jsonOut({ status: "SYNCED", files, imported });
    },
  }));

  // ---- workflow_role_save ----------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_role_save",
    description:
      "Save (create or update) a WORKFLOW ROLE — the contract template a workflow node " +
      "can bind to. A role declares what it does (description), which upstream artifacts " +
      "it accepts (inputs) and which artifacts it produces (outputs). Roles are " +
      "ADMIN-DEFINED: you (the agent) cannot alter them without a trusted-human approval. " +
      "Nodes bind a role at template-save time (fixed version), so later role edits never " +
      "shift the evidence anchor of bound nodes. Known roles: " +
      `${listRoles().map((r) => r.name).join(", ") || "(none yet — run workflow_role_list)"}.`,
    parameters: {
      name: { type: "string", required: true, description: "Role name (stable identifier)." },
      description: { type: "string", required: true, description: "What the role does: responsibilities, constraints." },
      inputs: {
        type: "array",
        required: true,
        description: "Upstream artifacts this role accepts: [{id, path, required}].",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            path: { type: "string", required: true },
            required: { type: "boolean", required: true },
          },
        },
      },
      outputs: {
        type: "array",
        required: true,
        description: "Artifacts this role produces: [{id, path, required, template?}].",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            path: { type: "string", required: true },
            required: { type: "boolean", required: true },
            template: {
              type: "string",
              description:
                "Optional content template for this output artifact. When set, workflow_advance " +
                "injects it into the missing-artifact response so the agent produces the deliverable " +
                "to spec; it is snapshotted into the evidence chain with the bound-role contract.",
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(
      args: { name: string; description: string; inputs: RoleArtifact[]; outputs: RoleArtifact[] },
      exec: { signal?: AbortSignal; agent?: unknown },
    ) {
      const { name } = args;
      appendRoleAudit(name, { actor: "agent", action: "role.save.requested", detail: { description: args.description, inputs: args.inputs, outputs: args.outputs } });
      // Validation first: invalid contracts never reach the approval gate.
      try {
        validateRoleInput({ name, version: 0, description: args.description, inputs: args.inputs, outputs: args.outputs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendRoleAudit(name, { actor: "system", action: "role.save.invalid", detail: { message } });
        throw error;
      }
      // Governance gate: only a trusted human can change role definitions.
      let approval: ApprovalResolution;
      try {
        approval = await resolveApproval(ctx, exec, "__roles__", name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendRoleAudit(name, { actor: "system", action: "role.save.error", detail: { message } });
        throw error;
      }
      if (approval.pending) {
        appendRoleAudit(name, { actor: "agent", action: "role.save.pending" });
        return jsonOut({ status: "AWAITING_APPROVAL", name, note: "trusted-human approval required; the role was NOT saved" });
      }
      if (approval.decision === "reject") {
        appendRoleAudit(name, { actor: approval.actor, action: "role.save.rejected" });
        return jsonOut({ status: "REJECTED", name, note: "trusted human rejected the role change; nothing was saved" });
      }
      const saved = saveRole({ name, version: 0, description: args.description, inputs: args.inputs, outputs: args.outputs });
      appendRoleAudit(name, {
        actor: approval.actor,
        action: saved.created ? "role.created" : "role.updated",
        detail: { version: saved.role.version },
      });
      return jsonOut({
        status: "SAVED",
        name,
        created: saved.created,
        version: saved.role.version,
        description: saved.role.description,
        inputs: saved.role.inputs,
        outputs: saved.role.outputs,
      });
    },
  }));

  // ---- workflow_role_list ----------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_role_list",
    description:
      "List the runtime-managed workflow roles (name, version, input/output artifact ids). " +
      "Use workflow_role_save to add or update a role (trusted-human gated).",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          roles: { type: "array", required: true },
        },
      },
      render: textRender,
    },
    async execute() {
      return jsonOut({ roles: listRoles() });
    },
  }));

  // ---- workflow_role_export --------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_role_export",
    description:
      "Export a runtime role as a portable, schema-tagged document " +
      "(schema 'workbench-role/v1', {role: {name, description, inputs, outputs}}) for backup, " +
      "migration or git-versioning. Read-only — no approval needed.",
    parameters: {
      name: { type: "string", required: true, description: "Role name to export." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          schema: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { name: string }) {
      const doc = exportRole(args.name);
      if (doc === null) {
        throw new Error(`unknown role "${args.name}" — known roles: ${listRoles().map((r) => r.name).join(", ") || "(none)"}`);
      }
      return jsonOut(doc);
    },
  }));

  // ---- workflow_role_import --------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_role_import",
    description:
      "Import a portable role document (as produced by workflow_role_export) under a target " +
      "role name. Trusted-human gated — the import is hard-blocked until approval. " +
      "The document's own role name is informational: importing under a different target name is allowed.",
    parameters: {
      name: { type: "string", required: true, description: "Target role name." },
      document: { type: "object", required: true, additionalProperties: true, description: "The portable role document (schema 'workbench-role/v1')." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { name: string; document: unknown }, exec: { signal?: AbortSignal; agent?: unknown }) {
      const { name, document } = args;
      appendRoleAudit(name, { actor: "agent", action: "role.import.requested", detail: { document } });
      // Shape validation first.
      try {
        const doc = document as { role?: unknown };
        if (typeof doc !== "object" || doc === null || typeof doc.role !== "object" || doc.role === null) {
          throw new Error("role import: document needs a role object");
        }
        const r = doc.role as WorkflowRole;
        validateRoleInput({ name, version: 0, description: r.description, inputs: r.inputs, outputs: r.outputs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendRoleAudit(name, { actor: "system", action: "role.import.invalid", detail: { message } });
        throw error;
      }
      let approval: ApprovalResolution;
      try {
        approval = await resolveApproval(ctx, exec, "__roles__", `import:${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendRoleAudit(name, { actor: "system", action: "role.import.error", detail: { message } });
        throw error;
      }
      if (approval.pending) {
        appendRoleAudit(name, { actor: "agent", action: "role.import.pending" });
        return jsonOut({ status: "AWAITING_APPROVAL", name, note: "trusted-human approval required; the role was NOT imported" });
      }
      if (approval.decision === "reject") {
        appendRoleAudit(name, { actor: approval.actor, action: "role.import.rejected" });
        return jsonOut({ status: "REJECTED", name, note: "trusted human rejected the import; nothing was saved" });
      }
      const imported = importRole(name, document);
      appendRoleAudit(name, {
        actor: approval.actor,
        action: imported.created ? "role.imported" : "role.imported.updated",
        detail: { version: imported.role.version },
      });
      return jsonOut({ status: "IMPORTED", name, created: imported.created, version: imported.role.version });
    },
  }));

  // ---- workflow_role_sync_project --------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_role_sync_project",
    description:
      "Sync workflow roles FROM the project into the runtime role store. " +
      "Reads every `.workbench-roles/*.json` file in the project (the role name comes from " +
      "the document's `name` field, falling back to the file basename). This is a governance action: " +
      "the whole sync is hard-blocked until a trusted human approves it. Files that fail to parse or " +
      "validate are reported WITHOUT being saved, and block the sync.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(_args: Record<string, never>, exec: { signal?: AbortSignal; agent?: unknown }) {
      const files = listProjectRoleFiles();
      if (files.length === 0) {
        return jsonOut({ status: "NO_FILES", note: "no .workbench-roles/*.json files in the project" });
      }
      const prepared: Array<{ fileName: string; name: string; document: unknown }> = [];
      const errors: Array<{ fileName: string; message: string }> = [];
      for (const fileName of files) {
        try {
          const { name, document } = readProjectRoleFile(fileName);
          const doc = document as { role?: unknown };
          if (typeof doc !== "object" || doc === null || typeof doc.role !== "object" || doc.role === null) {
            throw new Error("document needs a role object");
          }
          const r = doc.role as WorkflowRole;
          validateRoleInput({ name, version: 0, description: r.description, inputs: r.inputs, outputs: r.outputs });
          prepared.push({ fileName, name, document });
        } catch (error) {
          errors.push({ fileName, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (errors.length > 0) {
        appendRoleAudit("__sync__", { actor: "system", action: "role.sync.invalid", detail: { errors } });
        return jsonOut({ status: "INVALID", files, errors, note: "invalid project role files; nothing was imported" });
      }
      let approval: ApprovalResolution;
      try {
        approval = await resolveApproval(ctx, exec, "__roles__", "__sync__");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendRoleAudit("__sync__", { actor: "system", action: "role.sync.error", detail: { message } });
        throw error;
      }
      if (approval.pending) {
        appendRoleAudit("__sync__", { actor: "agent", action: "role.sync.pending" });
        return jsonOut({ status: "AWAITING_APPROVAL", files, note: "trusted-human approval required; nothing was imported" });
      }
      if (approval.decision === "reject") {
        appendRoleAudit("__sync__", { actor: approval.actor, action: "role.sync.rejected" });
        return jsonOut({ status: "REJECTED", files, note: "trusted human rejected the sync; nothing was imported" });
      }
      const imported = prepared.map(({ fileName, name, document }) => {
        const result = importRole(name, document);
        appendRoleAudit(name, {
          actor: approval.actor,
          action: result.created ? "role.synced" : "role.synced.updated",
          detail: { fileName, version: result.role.version },
        });
        return { fileName, name, created: result.created, version: result.role.version };
      });
      appendRoleAudit("__sync__", { actor: approval.actor, action: "role.sync.completed", detail: { files: imported } });
      return jsonOut({ status: "SYNCED", files, imported });
    },
  }));

  // ---- workflow_run_list -----------------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_run_list",
    description:
      "List all governed runs (runId, workflow, status, current node, startedAt), newest first. " +
      "Use workflow_audit to inspect a run's event stream or workflow_evidence_export to archive it.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          runs: { type: "array", required: true },
        },
      },
      render: textRender,
    },
    async execute() {
      return jsonOut({ runs: listRuns() });
    },
  }));

  // ---- workflow_evidence_export ----------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_evidence_export",
    description:
      "Export a tamper-evident evidence package for a run: the full event stream, every registered " +
      "artifact version, and a per-event SHA-256 hash chain (entry N hashes entry N-1 plus the event " +
      "content — any later edit breaks the chain). The package is written to " +
      ".workbench-evidence/<runId>.json inside the project (boundary enforced) so it can be archived " +
      "and git-versioned. Records an evidence.exported event.",
    parameters: {
      runId: { type: "string", required: true, description: "Run id from workflow_start." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string", required: true },
          runId: { type: "string", required: true },
        },
      },
      render: textRender,
    },
    async execute(args: { runId: string }) {
      const run = getRun(args.runId);
      if (run === null) throw new Error(`run not found: ${args.runId}`);
      const written = writeEvidencePackage(args.runId);
      if (written === null) throw new Error(`evidence export failed for run ${args.runId}`);
      appendEvent(args.runId, {
        actor: "system",
        action: "evidence.exported",
        detail: { path: written.path, packageHash: written.packageHash },
      });
      const pkg = buildEvidencePackage(args.runId);
      return jsonOut({
        status: "EXPORTED",
        runId: args.runId,
        path: written.path,
        packageHash: written.packageHash,
        events: (pkg?.events as unknown[])?.length ?? 0,
        artifacts: (pkg?.artifacts as unknown[])?.length ?? 0,
        note: "evidence package written into the project; hash chain is tamper-evident",
      });
    },
  }));

  // ---- workflow_approval_inbox -----------------------------------------
  ctx.tools.register(defineTool({
    name: "workflow_approval_inbox",
    description:
      "The approval inbox (read-only): every run currently blocked at an approval or artifact gate " +
      "(runId, workflow, nodeId, blockedBy, since), plus every template change waiting on a " +
      "trusted-human decision (save/import/sync pending). Use workflow_advance to re-attempt a " +
      "blocked run once its decision exists; use workflow_template_save/import/sync with an " +
      "approval for pending template changes.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          runs: { type: "array", required: true },
          templates: { type: "array", required: true },
        },
      },
      render: textRender,
    },
    async execute() {
      return jsonOut(approvalInbox());
    },
  }));

  // ---- Live HTTP endpoints for the workbench UI (web profile only) -----
  // The browser sidebar panel polls these to show the approval inbox / run
  // list in real time. ctx.inject defers the registration until the webServer
  // service appears (it binds asynchronously), and never fires in headless
  // profiles — so the plugin's own activation is unaffected there.
  ctx.inject(["webServer"], (httpCtx: { webServer: { register: (route: unknown) => void } }) => {
    const send = (res: { setHeader: (k: string, v: string) => void; end: (body: string) => void }, value: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    const sendText = (
      res: { setHeader: (k: string, v: string) => void; end: (body: string) => void; statusCode: number },
      code: number,
      text: string,
    ) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = code;
      res.end(JSON.stringify({ error: text }));
    };
    httpCtx.webServer.register({
      kind: "exact",
      path: "/workbench/inbox",
      handler: (_req: unknown, res: { setHeader: (k: string, v: string) => void; end: (body: string) => void }) => send(res, approvalInbox()),
    });
    httpCtx.webServer.register({
      kind: "exact",
      path: "/workbench/runs",
      handler: (_req: unknown, res: { setHeader: (k: string, v: string) => void; end: (body: string) => void }) => send(res, listRuns()),
    });
    // Cross-run artifact catalog for the workbench "产物" module: latest
    // registered version of every (run, node, artifact) with live disk state
    // (exists / drifted). Read-only.
    httpCtx.webServer.register({
      kind: "exact",
      path: "/workbench/artifacts",
      handler: (_req: unknown, res: { setHeader: (k: string, v: string) => void; end: (body: string) => void }) =>
        send(res, { artifacts: listAllArtifacts() }),
    });
    // One artifact's content for the browser: ?runId=&nodeId=&artifactId=
    // returns metadata + content (text inline, images base64, binary without
    // content); adding &version=&against= returns the two-version diff payload.
    // Paths are resolved inside the run's own project boundary only.
    httpCtx.webServer.register({
      kind: "prefix",
      path: "/workbench/artifact",
      handler: (
        req: { url?: string },
        res: { setHeader: (k: string, v: string) => void; end: (body: string) => void; statusCode: number },
      ) => {
        const url = new URL(req.url ?? "", "http://x");
        const runId = url.searchParams.get("runId") ?? "";
        const nodeId = url.searchParams.get("nodeId") ?? "";
        const artifactId = url.searchParams.get("artifactId") ?? "";
        if (runId === "" || nodeId === "" || artifactId === "") {
          sendText(res, 400, "artifact view requires runId, nodeId, artifactId");
          return;
        }
        const versionRaw = url.searchParams.get("version");
        const againstRaw = url.searchParams.get("against");
        const version = versionRaw !== null && /^\d+$/.test(versionRaw) ? Number(versionRaw) : undefined;
        const against = againstRaw !== null && /^\d+$/.test(againstRaw) ? Number(againstRaw) : undefined;
        try {
          send(res, readArtifactContent({ runId, nodeId, artifactId, version, against }));
        } catch (error) {
          sendText(res, 400, error instanceof Error ? error.message : String(error));
        }
      },
    });
    // One run's full detail for the UI: projection + registered artifacts +
    // event stream (run detail drawer / artifact-to-run navigation).
    httpCtx.webServer.register({
      kind: "prefix",
      path: "/workbench/run-detail",
      handler: (
        req: { url?: string },
        res: { setHeader: (k: string, v: string) => void; end: (body: string) => void; statusCode: number },
      ) => {
        const runId = new URL(req.url ?? "", "http://x").searchParams.get("runId") ?? "";
        if (runId === "") {
          sendText(res, 400, "run detail requires runId");
          return;
        }
        const detail = readRunDetail(runId);
        if (detail === null) {
          sendText(res, 404, `run not found: ${runId}`);
          return;
        }
        send(res, detail);
      },
    });
    // Full template list for the UI sidebar page: every runtime template as an
    // editable document (same shape as exportTemplate) plus the project-file
    // templates available for sync. Read-only.
    httpCtx.webServer.register({
      kind: "exact",
      path: "/workbench/templates",
      handler: (_req: unknown, res: { setHeader: (k: string, v: string) => void; end: (body: string) => void }) =>
        send(res, {
          templates: listTemplateDocuments(),
          projectFiles: listProjectTemplateFiles(),
        }),
    });
    // Role library endpoints: GET all roles as full contract documents, POST to
    // save one. The browser user of the role editor IS the trusted human —
    // saves are recorded with actor "ui-editor" and audited (same trust model
    // as the template visual editor).
    httpCtx.webServer.register({
      kind: "prefix",
      path: "/workbench/roles",
      handler: (
        req: { url?: string; method?: string; on: (ev: string, cb: (chunk: Buffer) => void) => void },
        res: { setHeader: (k: string, v: string) => void; end: (body: string) => void; statusCode: number },
      ) => {
        const url = req.url ?? "";
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                name?: unknown;
                description?: unknown;
                inputs?: unknown;
                outputs?: unknown;
              };
              if (typeof body.name !== "string" || typeof body.description !== "string" || !Array.isArray(body.inputs) || !Array.isArray(body.outputs)) {
                sendText(res, 400, "role save requires {name, description, inputs, outputs}");
                return;
              }
              const role = {
                name: body.name,
                version: 0,
                description: body.description,
                inputs: body.inputs as RoleArtifact[],
                outputs: body.outputs as RoleArtifact[],
              };
              validateRoleInput(role);
              const saved = saveRole(role);
              appendRoleAudit(body.name, {
                actor: "ui-editor",
                action: saved.created ? "role.created" : "role.updated",
                detail: { version: saved.role.version, source: "role-editor" },
              });
              send(res, { status: "SAVED", ...saved.role });
            } catch (error) {
              sendText(res, 400, error instanceof Error ? error.message : String(error));
            }
          });
          return;
        }
        send(res, {
          roles: listRoleDocuments(),
          projectFiles: listProjectRoleFiles(),
        });
      },
    });
    // Visual-editor endpoints: GET a template for editing, POST to save one.
    // The browser user of the visual editor IS the trusted human — saves are
    // recorded with actor "ui-editor" and audited. (Documented limitation: a
    // headless agent with file access could curl this endpoint, the same
    // forgery class as the decision-file fallback.)
    httpCtx.webServer.register({
      kind: "prefix",
      path: "/workbench/template",
      handler: (
        req: { url?: string; method?: string; on: (ev: string, cb: (chunk: Buffer) => void) => void },
        res: { setHeader: (k: string, v: string) => void; end: (body: string) => void; statusCode: number },
      ) => {
        const url = req.url ?? "";
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: unknown; firstNode?: unknown; nodes?: unknown };
              if (typeof body.name !== "string" || typeof body.firstNode !== "string" || !Array.isArray(body.nodes)) {
                sendText(res, 400, "template save requires {name, firstNode, nodes}");
                return;
              }
              validateTemplateInput(body.nodes as WorkflowNode[], body.firstNode);
              const saved = saveTemplate(body.nodes as WorkflowNode[], body.firstNode, body.name);
              appendTemplateAudit(body.name, {
                actor: "ui-editor",
                action: saved.created ? "template.created" : "template.updated",
                detail: { version: saved.template.version, source: "visual-editor" },
              });
              send(res, { status: "SAVED", ...saved.template });
            } catch (error) {
              sendText(res, 400, error instanceof Error ? error.message : String(error));
            }
          });
          return;
        }
        // GET: ?name=... returns the editable template document (or null).
        const name = new URL(url, "http://x").searchParams.get("name") ?? "";
        const doc = exportTemplate(name);
        send(res, { template: doc });
      },
    });
  });
}

export { apply, inject, name };
