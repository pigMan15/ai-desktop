// dump-store.mjs — print the SQLite event store as JSON for assertions/debugging.
// Usage:  $env:WORKBENCH_STORE = <store>; node scripts/dump-store.mjs
import {
  approvalInbox,
  listRuns,
  listTemplates,
  readEvents,
  readTemplateAudit,
} from "../packages/workbench-governance/dist/store.js";

const out = {
  runs: listRuns().map((run) => ({ ...run, events: readEvents(run.runId) })),
  templates: listTemplates().map((t) => ({ ...t, audit: readTemplateAudit(t.name) })),
  inbox: approvalInbox(),
};
console.log(JSON.stringify(out, null, 2));
