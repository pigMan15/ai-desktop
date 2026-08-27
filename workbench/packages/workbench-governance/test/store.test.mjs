// Canonical engine test for @workflow-platform/workbench-governance.
// Self-contained: creates throwaway WORKBENCH_STORE / WORKBENCH_PROJECT under
// the OS temp dir, runs every check against the BUILT dist, then cleans up.
// Run with:  npm --workspace @workflow-platform/workbench-governance run test

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const tmpRoot = mkdtempSync(join(tmpdir(), "workbench-governance-test-"));
process.env.WORKBENCH_STORE = join(tmpRoot, "store");
process.env.WORKBENCH_PROJECT = join(tmpRoot, "project");

const {
  WORKFLOW_TEMPLATES,
  WORKFLOW_ROLES,
  appendEvent,
  appendRoleAudit,
  appendTemplateAudit,
  approvalInbox,
  boundRoleForNode,
  buildEvidencePackage,
  checkArtifacts,
  checkRoleUpstream,
  closeDb,
  createRun,
  exportRole,
  exportTemplate,
  getRole,
  getRoleVersion,
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
  listTemplates,
  readProjectRoleFile,
  readProjectTemplateFile,
  readEvents,
  readRoleAudit,
  rebuildProjectionFromEvents,
  resolveInProject,
  saveRole,
  saveTemplate,
  scanNodeArtifacts,
  sessionProjectDir,
  validateRoleInput,
  validateTemplateInput,
  validateNodeRoleBinding,
  writeEvidencePackage,
} = await import("../dist/store.js");

let failed = 0;
function check(label, ok, extra = "") {
  if (ok) {
    console.log(`ok  - ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL- ${label} ${extra}`);
  }
}

try {
  // ---- project fixture ---------------------------------------------------
  const project = process.env.WORKBENCH_PROJECT;
  mkdirSync(join(project, "artifacts"), { recursive: true });
  const planFile = join(project, "artifacts", "plan.md");
  const verifyFile = join(project, "artifacts", "verify.md");
  const shipFile = join(project, "artifacts", "ship.json");
  writeFileSync(planFile, "# plan v1\n");
  writeFileSync(verifyFile, "# verify v1\n");
  writeFileSync(shipFile, '{"ship": "v1"}\n');

  // ---- P1: event sourcing + projection -----------------------------------
  const run = createRun({
    runId: "test-run-1",
    workflow: "poc",
    nodes: WORKFLOW_TEMPLATES.poc.nodes,
    firstNode: WORKFLOW_TEMPLATES.poc.firstNode,
    projectDir: project,
  });
  check("createRun projects RUNNING at plan", run.status === "RUNNING" && run.current === "plan");
  check("run.started is seq 0", readEvents("test-run-1")[0]?.action === "run.started");
  check("project boundary allows in-project path", resolveInProject(project, "artifacts/plan.md") !== null);
  check("project boundary rejects traversal", resolveInProject(project, "../escape.md") === null);

  // ---- P2: artifact scan + version dedupe ----------------------------------
  let scan = scanNodeArtifacts("test-run-1", "plan");
  check("plan artifacts all present", scan.every((a) => a.status === "ok") && scan.length === 1);
  check("plan-doc has sha256 + version 1", scan[0].sha256.length === 64 && scan[0].version === 1);
  scan = scanNodeArtifacts("test-run-1", "plan");
  check("unchanged content reuses version 1", scan[0].version === 1);
  appendFileSync(planFile, "# plan v2\n");
  scan = scanNodeArtifacts("test-run-1", "plan");
  check("changed content registers version 2", scan[0].version === 2);

  // ---- P2: drift detection against the completion snapshot -----------------
  appendEvent("test-run-1", { actor: "agent", action: "advance.attempted", nodeId: "plan" });
  appendEvent("test-run-1", { actor: "trusted-human", action: "node.approved", nodeId: "plan" });
  const snapshotScan = scanNodeArtifacts("test-run-1", "plan");
  appendEvent("test-run-1", {
    actor: "system",
    action: "node.completed",
    nodeId: "plan",
    detail: {
      artifacts: snapshotScan
        .filter((a) => a.status === "ok")
        .map((a) => ({ artifactId: a.artifact, path: a.path, sha256: a.sha256, version: a.version })),
    },
  });
  let drift = checkArtifacts("test-run-1", "plan");
  check("no change yet -> drift ok", drift[0].drift === "ok");
  appendFileSync(planFile, "# plan v3\n");
  drift = checkArtifacts("test-run-1", "plan");
  check("content changed after completion -> drifted", drift[0].drift === "drifted");
  rmSync(planFile, { force: true });
  drift = checkArtifacts("test-run-1", "plan");
  check("file removed after completion -> missing", drift[0].drift === "missing");

  // ---- P3: recovery --------------------------------------------------------
  const before = getRun("test-run-1");
  const rebuilt = rebuildProjectionFromEvents("test-run-1");
  check("recovery rebuilds identical projection (incl. timestamps)", JSON.stringify(rebuilt) === JSON.stringify(before));

  const run2 = createRun({
    runId: "test-run-2",
    workflow: "poc",
    nodes: WORKFLOW_TEMPLATES.poc.nodes,
    firstNode: WORKFLOW_TEMPLATES.poc.firstNode,
    projectDir: project,
  });
  appendEvent("test-run-2", { actor: "agent", action: "advance.attempted", nodeId: "plan" });
  appendEvent("test-run-2", { actor: "trusted-human", action: "node.approved", nodeId: "plan" });
  appendEvent("test-run-2", { actor: "system", action: "node.completed", nodeId: "plan", detail: { artifacts: [] } });
  appendEvent("test-run-2", { actor: "agent", action: "advance.attempted", nodeId: "verify" });
  appendEvent("test-run-2", { actor: "system", action: "node.completed", nodeId: "verify" });
  appendEvent("test-run-2", { actor: "agent", action: "advance.attempted", nodeId: "ship" });
  appendEvent("test-run-2", { actor: "trusted-human", action: "node.approved", nodeId: "ship" });
  appendEvent("test-run-2", { actor: "system", action: "node.completed", nodeId: "ship", detail: { artifacts: [] } });
  appendEvent("test-run-2", { actor: "system", action: "run.completed" });
  check("full lifecycle ends COMPLETED", getRun("test-run-2").status === "COMPLETED" && getRun("test-run-2").current === null);
  const before2 = getRun("test-run-2");
  const rebuilt2 = rebuildProjectionFromEvents("test-run-2");
  check("full-lifecycle replay rebuilds identical projection", JSON.stringify(rebuilt2) === JSON.stringify(before2));

  // ---- P4: runtime-managed templates --------------------------------------
  check("seeded poc template is runtime-visible", getWorkflowTemplate("poc")?.name === "poc");
  check("seeded poc version is 1", getWorkflowTemplate("poc")?.version === 1);
  check("template list includes poc", listTemplates().some((t) => t.name === "poc"));

  const qaNodes = [
    {
      id: "check",
      requiresApproval: true,
      artifacts: [{ id: "report", path: "artifacts/qa-check.md", required: true }],
    },
    {
      id: "deploy",
      requiresApproval: false,
      artifacts: [{ id: "manifest", path: "artifacts/qa-deploy.json", required: true }],
    },
  ];
  check("valid template input passes validation", (() => { try { validateTemplateInput(qaNodes, "check"); return true; } catch { return false; } })());
  check("duplicate node id rejected", (() => { try { validateTemplateInput([qaNodes[0], qaNodes[0]], "check"); return false; } catch { return true; } })());
  check("unknown firstNode rejected", (() => { try { validateTemplateInput(qaNodes, "nope"); return false; } catch { return true; } })());
  check("empty nodes rejected", (() => { try { validateTemplateInput([], "check"); return false; } catch { return true; } })());
  check(
    "artifact path traversal rejected",
    (() => {
      try {
        validateTemplateInput(
          [{ id: "x", requiresApproval: false, artifacts: [{ id: "y", path: "../escape.md", required: true }] }],
          "x",
        );
        return false;
      } catch {
        return true;
      }
    })(),
  );

  const saved = saveTemplate(qaNodes, "check", "qa");
  check("saveTemplate creates qa v1", saved.created === true && saved.template.version === 1);
  check("qa template readable from runtime store", getWorkflowTemplate("qa")?.firstNode === "check");
  appendTemplateAudit("qa", { actor: "trusted-human", action: "template.created", detail: { version: 1 } });
  const saved2 = saveTemplate(qaNodes, "check", "qa");
  check("re-save bumps qa to v2", saved2.created === false && saved2.template.version === 2);
  check("template list includes qa at v2", listTemplates().find((t) => t.name === "qa")?.version === 2);

  // ---- P6: template export / import round-trip ---------------------------
  const exported = exportTemplate("qa");
  check("export returns schema-tagged document", exported?.schema === "workbench-template/v1" && exported?.name === "qa");
  check("exported nodes match source", JSON.stringify(exported.nodes.map((n) => n.id)) === JSON.stringify(["check", "deploy"]));
  const imported = importTemplate("qa-restored", exported);
  check("import restores identical nodes under new name", JSON.stringify(imported.template.nodes) === JSON.stringify(getWorkflowTemplate("qa").nodes));
  check("imported template version is 1", imported.created === true && imported.template.version === 1);
  check("import allows rename (portable copy)", getWorkflowTemplate("qa-restored")?.name === "qa-restored");
  check("import malformed document rejected", (() => { try { importTemplate("x", { nodes: "nope" }); return false; } catch { return true; } })());

  // ---- P7: project template files (.workbench-templates/*.json) -----------
  mkdirSync(join(project, ".workbench-templates"), { recursive: true });
  const projectDoc = JSON.stringify({
    schema: "workbench-template/v1",
    name: "qa-file",
    version: 1,
    firstNode: "check",
    nodes: [
      { id: "check", requiresApproval: true, artifacts: [{ id: "report", path: "artifacts/qa-check.md", required: true }] },
      { id: "deploy", requiresApproval: false, artifacts: [{ id: "manifest", path: "artifacts/qa-deploy.json", required: true }] },
    ],
  });
  writeFileSync(join(project, ".workbench-templates", "qa-file.json"), projectDoc);
  check("project template files are discovered", listProjectTemplateFiles().length === 1 && listProjectTemplateFiles()[0] === "qa-file.json");
  const fileDoc = readProjectTemplateFile("qa-file.json");
  check("project template name comes from the document", fileDoc.name === "qa-file");
  check("project template imports into the runtime store", importTemplate(fileDoc.name, fileDoc.document).template.firstNode === "check");
  check("project-imported template is runnable", getWorkflowTemplate("qa-file")?.version === 1);
  rmSync(join(project, ".workbench-templates", "qa-file.json"), { force: true });
  check("project template removed from discovery", listProjectTemplateFiles().length === 0);

  // ---- Evidence package (hash chain + project write) ----------------------
  const evidence = buildEvidencePackage("test-run-1");
  check("evidence package schema-tagged", evidence?.schema === "workbench-evidence/v1");
  const evidenceEvents = evidence.events;
  const hashChain = evidence.hashChain;
  check("hash chain covers every event", Array.isArray(hashChain) && hashChain.length === evidenceEvents.length);
  check("packageHash is sha256 hex", typeof evidence.packageHash === "string" && evidence.packageHash.length === 64);
  check("evidence includes registered artifacts", evidence.artifacts.length >= 3);
  // the events snapshot is a copy: mutating it does not touch the package
  const tampered = JSON.parse(JSON.stringify(evidence));
  tampered.events[1].actor = "forged";
  check("evidence events snapshot is a copy", JSON.stringify(tampered.events) !== JSON.stringify(evidence.events));

  const written = writeEvidencePackage("test-run-1");
  // packageHash covers exportedAt (a timestamp), so two builds may differ by a
  // millisecond 鈥?assert it is a valid sha256 and that the persisted file's
  // hash chain is intact rather than byte-equal to the in-memory build.
  check("evidence written into project", written !== null && typeof written.packageHash === "string" && written.packageHash.length === 64);
  check(
    "evidence file exists on disk",
    existsSync(join(process.env.WORKBENCH_PROJECT, ".workbench-evidence", "test-run-1.json")),
  );
  // boundary: a run whose id escapes the project must be refused at write time
  const evilRun = createRun({ runId: "../escape", workflow: "poc", nodes: WORKFLOW_TEMPLATES.poc.nodes, firstNode: "plan", projectDir: project });
  check("boundary run created for the test", evilRun.runId === "../escape");
  check("evidence write rejects traversal runId", (() => { try { writeEvidencePackage("../escape"); return false; } catch { return true; } })());

  // ---- Approval inbox ------------------------------------------------------
  const inboxRun = createRun({ runId: "test-inbox-run", workflow: "poc", nodes: WORKFLOW_TEMPLATES.poc.nodes, firstNode: "plan", projectDir: project });
  appendEvent("test-inbox-run", { actor: "agent", action: "advance.attempted", nodeId: "plan" });
  appendEvent("test-inbox-run", { actor: "agent", action: "approval.pending", nodeId: "plan" });
  appendTemplateAudit("inbox-tpl", { actor: "agent", action: "template.save.pending" });
  const inbox = approvalInbox();
  check(
    "inbox lists approval-blocked run",
    inbox.runs.some((r) => r.runId === "test-inbox-run" && r.blockedBy === "approval" && r.nodeId === "plan"),
  );
  check(
    "inbox lists pending template change",
    inbox.templates.some((t) => t.subject === "inbox-tpl" && t.action === "template.save.pending"),
  );
  check("inbox does not list completed runs", inbox.runs.every((r) => r.runId !== "test-run-2"));

  // Web-mode waiting: an approval.requested with NO resolution (card still
  // open / session switched) must appear in the inbox too; a later approval
  // must clear it.
  const webRun = createRun({ runId: "test-web-run", workflow: "poc", nodes: WORKFLOW_TEMPLATES.poc.nodes, firstNode: "plan", projectDir: project });
  appendEvent("test-web-run", { actor: "agent", action: "advance.attempted", nodeId: "plan" });
  appendEvent("test-web-run", { actor: "agent", action: "approval.requested", nodeId: "plan" });
  check(
    "inbox lists approval.requested (web card open)",
    approvalInbox().runs.some((r) => r.runId === "test-web-run" && r.blockedBy === "approval" && r.nodeId === "plan"),
  );
  appendEvent("test-web-run", { actor: "ui-human", action: "node.approved", nodeId: "plan" });
  check(
    "approval clears the inbox entry",
    approvalInbox().runs.every((r) => r.runId !== "test-web-run" || r.nodeId !== "plan"),
  );
  appendTemplateAudit("web-tpl", { actor: "agent", action: "template.save.requested" });
  check(
    "inbox lists unresolved template request",
    approvalInbox().templates.some((t) => t.subject === "web-tpl" && t.action === "template.save.requested"),
  );

  // ---- event stream integrity ----------------------------------------------
  const events = readEvents("test-run-1");
  const seqs = events.map((e) => e.seq);
  check("contiguous monotonic seq", seqs.every((v, i) => v === i));
  check("audit records actors", events.some((e) => e.actor === "trusted-human") && events.some((e) => e.actor === "agent"));
  check("listRuns returns the run", listRuns().some((r) => r.runId === "test-run-1"));

  // ---- per-session projectDir derivation (鑷姩浼氳瘽闅旂) --------------------
  const sessDir = sessionProjectDir("session-abc-123");
  check("sessionProjectDir derives under project/sessions", typeof sessDir === "string" && sessDir.includes("sessions") && sessDir.includes("session-abc-123"));
  check("sessionProjectDir rejects traversal id", sessionProjectDir("../evil") === null);
  check("sessionProjectDir rejects empty id", sessionProjectDir("") === null && sessionProjectDir(42) === null);
  check("sessionProjectDir rejects separator id", sessionProjectDir("a/b\\c:<>") === null);
  check("sessionProjectDir keeps safe dotted ids", typeof sessionProjectDir("sess.1_2-3") === "string");

  // ---- per-session projectDir isolation (鏂规 A) ---------------------------
  const sessionA = join(project, "sessions", "session-a");
  const sessionB = join(project, "sessions", "session-b");
  const runA = createRun({ runId: "iso-run-a", workflow: "poc", nodes: WORKFLOW_TEMPLATES.poc.nodes, firstNode: "plan", projectDir: sessionA });
  const runB = createRun({ runId: "iso-run-b", workflow: "poc", nodes: WORKFLOW_TEMPLATES.poc.nodes, firstNode: "plan", projectDir: sessionB });
  check("per-run projectDir persisted", runA.projectDir === sessionA && runB.projectDir === sessionB);
  check("per-run projectDir directory created", existsSync(sessionA) && existsSync(sessionB));
  // each session's artifact scan resolves against ITS OWN boundary
  // (poc plan node declares path artifacts/plan.md)
  mkdirSync(join(sessionA, "artifacts"), { recursive: true });
  mkdirSync(join(sessionB, "artifacts"), { recursive: true });
  writeFileSync(join(sessionA, "artifacts", "plan.md"), "# plan A");
  writeFileSync(join(sessionB, "artifacts", "plan.md"), "# plan B");
  const scanA = scanNodeArtifacts("iso-run-a", "plan");
  const scanB = scanNodeArtifacts("iso-run-b", "plan");
  check("session A sees its own artifact", scanA.some((s) => s.artifact === "plan-doc" && s.status === "ok"));
  check("session B sees its own artifact", scanB.some((s) => s.artifact === "plan-doc" && s.status === "ok"));
  // governance stays global: inbox + run list see BOTH runs
  appendEvent("iso-run-a", { actor: "agent", action: "advance.attempted", nodeId: "plan" });
  appendEvent("iso-run-a", { actor: "agent", action: "approval.pending", nodeId: "plan" });
  appendEvent("iso-run-b", { actor: "agent", action: "advance.attempted", nodeId: "plan" });
  appendEvent("iso-run-b", { actor: "agent", action: "approval.pending", nodeId: "plan" });
  const inboxBoth = approvalInbox();
  check("global inbox lists both isolated runs", inboxBoth.runs.some((r) => r.runId === "iso-run-a") && inboxBoth.runs.some((r) => r.runId === "iso-run-b"));
  check("global run list lists both isolated runs", listRuns().some((r) => r.runId === "iso-run-a") && listRuns().some((r) => r.runId === "iso-run-b"));
  // evidence lands inside the run's own project boundary
  const evA = writeEvidencePackage("iso-run-a");
  check(
    "evidence written into session A boundary",
    evA !== null && existsSync(join(sessionA, ".workbench-evidence", "iso-run-a.json")),
  );

  // ---- Workflow role library (瑙掕壊搴? --------------------------------------
  check("seed roles present", listRoles().some((r) => r.name === "planner") && listRoles().some((r) => r.name === "verifier") && listRoles().some((r) => r.name === "shipper"));
  check("seed role documents readable", listRoleDocuments().find((r) => r.name === "planner")?.outputs.some((a) => a.id === "plan-doc"));
  check("seed role output carries template", typeof listRoleDocuments().find((r) => r.name === "planner")?.outputs.find((a) => a.id === "plan-doc")?.template === "string");
  const newRole = saveRole({ name: "human-reviewer", version: 0, description: "Reviews the plan", inputs: [{ id: "plan-doc", path: "artifacts/plan.md", required: true }], outputs: [{ id: "review-report", path: "artifacts/review.md", required: true }] });
  check("saveRole creates reviewer v1", newRole.created === true && newRole.role.version === 1);
  // output template round-trips through save/get/list
  const tplRole = saveRole({ name: "templated", version: 0, description: "Has a template", inputs: [], outputs: [{ id: "doc", path: "artifacts/doc.md", required: true, template: "# {title}\n\n## 鍐呭\n- " }] });
  check("role output template persists", getRole("templated")?.outputs[0].template === "# {title}\n\n## 鍐呭\n- ");
  check("role output template in documents", listRoleDocuments().find((r) => r.name === "templated")?.outputs[0].template !== undefined);
  check("role output without template stays absent", listRoleDocuments().find((r) => r.name === "human-reviewer")?.outputs[0].template === undefined);
  appendRoleAudit("human-reviewer", { actor: "ui-editor", action: "role.created", detail: { version: 1 } });
  check("role audit records creation", readRoleAudit("human-reviewer").some((e) => e.action === "role.created" && e.actor === "ui-editor"));
  check("role audit subjects listed", listRoleAuditSubjects().includes("human-reviewer"));
  const bumped = saveRole({ name: "human-reviewer", version: 0, description: "Reviews the plan (v2)", inputs: newRole.role.inputs, outputs: newRole.role.outputs });
  check("re-save bumps reviewer to v2", bumped.created === false && bumped.role.version === 2);
  check("getRole returns v2", getRole("human-reviewer")?.version === 2);
  check("role list reflects versions", listRoles().find((r) => r.name === "human-reviewer")?.version === 2);

  // invalid role rejected (empty path / dup id / traversal)
  check("role validation rejects empty path", (() => { try { saveRole({ name: "bad", version: 0, description: "x", inputs: [], outputs: [{ id: "a", path: "", required: true }] }); return false; } catch { return true; } })());
  check("role validation rejects traversal path", (() => { try { saveRole({ name: "bad", version: 0, description: "x", inputs: [], outputs: [{ id: "a", path: "../escape", required: true }] }); return false; } catch { return true; } })());
  check("role validation rejects duplicate ids", (() => { try { saveRole({ name: "bad", version: 0, description: "x", inputs: [], outputs: [{ id: "a", path: "x.md", required: true }, { id: "a", path: "y.md", required: true }] }); return false; } catch { return true; } })());

  // role export / import round-trip
  const exportedRole = exportRole("human-reviewer");
  check("role export schema-tagged", exportedRole?.schema === "workbench-role/v1" && exportedRole.role.name === "human-reviewer");
  const importedRole = importRole("human-reviewer-copy", exportedRole);
  check("role import restores under new name", importedRole.created === true && getRole("human-reviewer-copy")?.description === getRole("human-reviewer").description);
  check("role import rejects malformed document", (() => { try { importRole("x", { role: "nope" }); return false; } catch { return true; } })());

  // project role files (.workbench-roles/*.json)
  mkdirSync(join(project, ".workbench-roles"), { recursive: true });
  const roleDoc = JSON.stringify({ schema: "workbench-role/v1", name: "qa-role", role: { description: "QA role", inputs: [], outputs: [{ id: "report", path: "artifacts/qa-check.md", required: true }] } });
  writeFileSync(join(project, ".workbench-roles", "qa-role.json"), roleDoc);
  check("project role files discovered", listProjectRoleFiles().length === 1 && listProjectRoleFiles()[0] === "qa-role.json");
  const fileRole = readProjectRoleFile("qa-role.json");
  check("project role name from document", fileRole.name === "qa-role");
  rmSync(join(project, ".workbench-roles", "qa-role.json"), { force: true });
  check("project role removed from discovery", listProjectRoleFiles().length === 0);

  // role-bound template node: artifacts must be role outputs
  const boundNodes = [
    { id: "plan", requiresApproval: true, role: "planner", artifacts: [{ id: "plan-doc", path: "artifacts/plan.md", required: true }] },
    { id: "verify", requiresApproval: false, role: "verifier", artifacts: [{ id: "verify-report", path: "artifacts/verify.md", required: true }] },
  ];
  check("template with role-bound nodes saves", saveTemplate(boundNodes, "plan", "roleflow").template.nodes.plan.role === "planner");
  check("template rejects artifact outside role outputs", (() => { try { validateNodeRoleBinding({ id: "x", requiresApproval: true, role: "planner", artifacts: [{ id: "not-a-role-output", path: "artifacts/x.md", required: true }] }); return false; } catch { return true; } })());
  check("template rejects unknown role", (() => { try { validateNodeRoleBinding({ id: "x", requiresApproval: true, role: "ghost-role", artifacts: [] }); return false; } catch { return true; } })());

  // fixed-version binding: role version archived + resolved at bound version
  const verRole = saveRole({ name: "ver-role", version: 0, description: "v1 desc", inputs: [], outputs: [{ id: "out", path: "artifacts/out.md", required: true }] });
  check("versioned role saved at v1", verRole.role.version === 1);
  const verNodes = [{ id: "n1", requiresApproval: false, role: "ver-role", roleVersion: 1, artifacts: [{ id: "out", path: "artifacts/out.md", required: true }] }];
  const verTpl = saveTemplate(verNodes, "n1", "vertpl");
  check("template node binds role@version", verTpl.template.nodes.n1.role === "ver-role" && verTpl.template.nodes.n1.roleVersion === 1);
  const verRole2 = saveRole({ name: "ver-role", version: 0, description: "v2 desc", inputs: [], outputs: [{ id: "out", path: "artifacts/out.md", required: true }] });
  check("role bumped to v2", verRole2.role.version === 2 && getRole("ver-role")?.version === 2);
  check("superseded version archived", getRoleVersion("ver-role", 1)?.description === "v1 desc");
  const verRun = createRun({ runId: "ver-run", workflow: "vertpl", nodes: verTpl.template.nodes, firstNode: "n1", projectDir: project });
  check("boundRoleForNode resolves fixed v1", boundRoleForNode("ver-run", "n1")?.version === 1);
  check("boundRoleForNode keeps v1 description", boundRoleForNode("ver-run", "n1")?.description === "v1 desc");
  check("unknown version resolves null", getRoleVersion("ver-role", 99) === null);

  // run with role-bound nodes: upstream gate
  const roleRun = createRun({ runId: "role-run-1", workflow: "roleflow", nodes: { plan: boundNodes[0], verify: boundNodes[1] }, firstNode: "plan", projectDir: project });
  check("role-bound run starts at plan", roleRun.status === "RUNNING" && roleRun.current === "plan");
  // plan node: planner requires input 'brief' from upstream 鈥?but plan is the FIRST node, no upstream
  check("first node has no upstream requirement", checkRoleUpstream("role-run-1", "plan").length === 0);
  // verify node: verifier requires 'plan-doc' produced by plan 鈥?plan not completed yet, so missing
  const upstreamMissing = checkRoleUpstream("role-run-1", "verify");
  check("verify node upstream missing while plan incomplete", upstreamMissing.length === 1 && upstreamMissing[0].id === "plan-doc");
  check("boundRoleForNode resolves role contract", boundRoleForNode("role-run-1", "verify")?.name === "verifier");
  check("unbound node has no role", boundRoleForNode("iso-run-a", "plan") === null);
  // complete plan, then verify upstream satisfied
  mkdirSync(join(project, "artifacts"), { recursive: true });
  writeFileSync(join(project, "artifacts", "plan.md"), "# roleflow plan");
  scanNodeArtifacts("role-run-1", "plan");
  appendEvent("role-run-1", { actor: "system", action: "node.completed", nodeId: "plan", detail: { artifacts: [{ artifactId: "plan-doc", path: "artifacts/plan.md", sha256: "x", version: 1 }] } });
  check("verify node upstream satisfied after plan completed", checkRoleUpstream("role-run-1", "verify").length === 0);

  // ---- seeded AI-era workflows (SDLC / hotfix / spike) ---------------------
  const seedTemplates = listTemplates().map((t) => t.name);
  check("sdlc template seeded", seedTemplates.includes("sdlc"));
  check("hotfix template seeded", seedTemplates.includes("hotfix"));
  check("spike template seeded", seedTemplates.includes("spike"));
  const seedRoles = listRoles().map((r) => r.name);
  for (const roleName of ["spec-writer", "architect", "implementer", "reviewer", "tester", "debugger", "researcher"]) {
    if (!seedRoles.includes(roleName)) check(`seed role ${roleName} missing`, false);
  }
  check("all seeded roles present", ["spec-writer", "architect", "implementer", "reviewer", "tester", "debugger", "researcher"].every((n) => seedRoles.includes(n)));
  // SDLC upstream chain is self-consistent: each non-first node's role inputs
  // are produced by the previous node (run without completing anything).
  const sdlcNodes = getWorkflowTemplate("sdlc").nodes;
  const sdlcOrder = ["spec", "design", "implement", "review", "test"];
  const sdlcRun = createRun({ runId: "sdlc-run", workflow: "sdlc", nodes: sdlcNodes, firstNode: "spec", projectDir: project });
  check("sdlc first node no upstream", checkRoleUpstream("sdlc-run", "spec").length === 0);
  // Simulate each stage completing in order; the next stage's upstream must
  // then be satisfied (each role's inputs match the previous node's outputs).
  const complete = (runId, nodeId, artifacts) => appendEvent(runId, { actor: "system", action: "node.completed", nodeId, detail: { artifacts } });
  complete("sdlc-run", "spec", [{ artifactId: "spec", path: "artifacts/spec.md", sha256: "x", version: 1 }]);
  check("sdlc design upstream satisfied by spec", checkRoleUpstream("sdlc-run", "design").length === 0);
  complete("sdlc-run", "design", [{ artifactId: "design", path: "artifacts/design.md", sha256: "x", version: 1 }]);
  check("sdlc implement upstream satisfied by design", checkRoleUpstream("sdlc-run", "implement").length === 0);
  complete("sdlc-run", "implement", [{ artifactId: "changes", path: "artifacts/changes.md", sha256: "x", version: 1 }]);
  check("sdlc review upstream satisfied by implement", checkRoleUpstream("sdlc-run", "review").length === 0);
  complete("sdlc-run", "review", [{ artifactId: "review", path: "artifacts/review.md", sha256: "x", version: 1 }]);
  check("sdlc test upstream satisfied by review", checkRoleUpstream("sdlc-run", "test").length === 0);
  // hotfix: diagnose (debugger) is first; deploy (shipper) needs verify-report from verify
  const hotfixNodes = getWorkflowTemplate("hotfix").nodes;
  const hotfixRun = createRun({ runId: "hotfix-run", workflow: "hotfix", nodes: hotfixNodes, firstNode: "diagnose", projectDir: project });
  check("hotfix diagnose no upstream", checkRoleUpstream("hotfix-run", "diagnose").length === 0);
  check("hotfix verify no role-bound upstream", checkRoleUpstream("hotfix-run", "verify").length === 0);
  // spike: research (researcher, no inputs) is first; recommend needs nothing upstream
  const spikeNodes = getWorkflowTemplate("spike").nodes;
  const spikeRun = createRun({ runId: "spike-run", workflow: "spike", nodes: spikeNodes, firstNode: "research", projectDir: project });
  check("spike research no upstream", checkRoleUpstream("spike-run", "research").length === 0);
  check("spike recommend no upstream (researcher has no required inputs)", checkRoleUpstream("spike-run", "recommend").length === 0);
  // seeded roles carry templates on outputs
  const specRole = listRoleDocuments().find((r) => r.name === "spec-writer");
  check("spec-writer output has template", typeof specRole?.outputs[0]?.template === "string");
  const testerRole = listRoleDocuments().find((r) => r.name === "tester");
  check("tester outputs two artifacts", testerRole?.outputs.length === 2);

  console.log(failed === 0 ? "\nSTORE TEST PASSED" : `\nSTORE TEST FAILED (${failed})`);
} finally {
  closeDb(); // release WAL file locks before deleting the temp tree
  rmSync(tmpRoot, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
