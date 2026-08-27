// workbench-ui host half.
//
// The loader imports every plugin at the package root; the browser half is
// served separately through the "./client" export (dsh-client-modules reads
// `dsh.client` from package.json). The UI itself lives in client.js; this host
// half exists so the package resolves as a plugin entry — a placeholder that
// may later own host-side data/RPC for the workbench panels.

const name = "workbench-ui";
const inject = [];

function apply() {
  // Host half intentionally empty: the workbench UI is client-side today.
  // Future: host RPC (run lists, artifact hashes) served to the panels here.
}

export { apply, inject, name };
