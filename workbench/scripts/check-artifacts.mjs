// check-artifacts.mjs — re-validate a node's artifacts against the hash
// snapshot recorded at completion (drift detection).
// Usage:  $env:WORKBENCH_STORE=<store>; $env:WORKBENCH_PROJECT=<project>;
//         node scripts/check-artifacts.mjs <runId> <nodeId>
import { checkArtifacts } from "../packages/workbench-governance/dist/store.js";

const [runId, nodeId] = process.argv.slice(2);
if (!runId || !nodeId) {
  console.error("usage: node scripts/check-artifacts.mjs <runId> <nodeId>");
  process.exit(2);
}
console.log(JSON.stringify({ runId, nodeId, artifacts: checkArtifacts(runId, nodeId) }, null, 2));
