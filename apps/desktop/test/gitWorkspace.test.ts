import assert from "node:assert/strict";

import { GitWorkspaceManager, type GitCommandRunner } from "../src/main/gitWorkspace.js";

const calls: Array<{ args: string[]; cwd: string }> = [];
let porcelain = "";
let branch = "main";

const runGit: GitCommandRunner = async (args, cwd) => {
  calls.push({ args, cwd });
  if (args.join(" ") === "rev-parse --is-inside-work-tree") {
    return "true\n";
  }
  if (args.join(" ") === "rev-parse HEAD") {
    return "abc1234\n";
  }
  if (args.join(" ") === "symbolic-ref --quiet --short HEAD") {
    if (!branch) {
      throw new Error("detached HEAD");
    }
    return `${branch}\n`;
  }
  if (args.join(" ") === "status --porcelain=v1") {
    return porcelain;
  }
  if (args.join(" ") === "worktree list --porcelain") {
    return "worktree G:\\Project\\demo\nHEAD abc123\nbranch refs/heads/main\n";
  }
  if (args[0] === "merge-base") {
    return "";
  }
  return "";
};

const manager = new GitWorkspaceManager({ runGit });
const projectRoot = "G:\\Project\\demo";

const status = await manager.status(projectRoot);
assert.deepEqual(status, {
  rootPath: projectRoot,
  branch: "main",
  detachedHead: false,
  dirty: false,
  changes: [],
});

porcelain = " M README.md\n?? notes.txt\n";
const dirtyStatus = await manager.status(projectRoot);
assert.equal(dirtyStatus.dirty, true);
assert.deepEqual(dirtyStatus.changes, ["M README.md", "?? notes.txt"]);
await assert.rejects(
  () => manager.createWorktree(projectRoot, "feature/review"),
  /工作区存在未提交变更/,
);

porcelain = "";
await assert.rejects(
  () => manager.createWorktree(projectRoot, "../escape"),
  /非法 Git 分支名称/,
);

const worktree = await manager.createWorktree(projectRoot, "feature/review");
assert.equal(worktree.branch, "feature/review");
assert.equal(worktree.path, "G:\\Project\\demo\\.workflow-platform\\worktrees\\feature-review");
assert.deepEqual(calls.at(-1), {
  args: [
    "worktree",
    "add",
    "-b",
    "feature/review",
    "G:\\Project\\demo\\.workflow-platform\\worktrees\\feature-review",
    "HEAD",
  ],
  cwd: projectRoot,
});

branch = "";
await assert.rejects(() => manager.mergeBack(projectRoot, "feature/review"), /分离 HEAD/);

branch = "main";
const mergeStart = calls.length;
await manager.mergeBack(projectRoot, "feature/review");
assert.deepEqual(calls.slice(mergeStart + 3, mergeStart + 5), [
  { args: ["merge-base", "--is-ancestor", "main", "feature/review"], cwd: projectRoot },
  { args: ["merge", "--ff-only", "feature/review"], cwd: projectRoot },
]);

const knowledgeWrites: Array<{ path: string; content: string }> = [];
const knowledgeManager = new GitWorkspaceManager({
  runGit,
  knowledgeFiles: {
    ensureDirectory: async () => undefined,
    readText: async () => "# 旧知识\n",
    writeText: async (filePath, content) => {
      knowledgeWrites.push({ path: filePath, content });
    },
  },
});
const preview = await knowledgeManager.previewKnowledgeDocument(
  projectRoot,
  "knowledge-document-1",
  "# 新知识\n",
);
assert.deepEqual(preview, {
  relativePath: ".workflow-platform/knowledge/knowledge-document-1.md",
  previousContent: "# 旧知识\n",
  nextContent: "# 新知识\n",
});

const publishStart = calls.length;
const publishedKnowledge = await knowledgeManager.publishKnowledgeDocument(
  projectRoot,
  "knowledge-document-1",
  "# 新知识\n",
);
assert.equal(publishedKnowledge.branch, "main");
assert.equal(publishedKnowledge.commitHash, "abc1234");
assert.deepEqual(knowledgeWrites, [
  {
    path: "G:\\Project\\demo\\.workflow-platform\\knowledge\\knowledge-document-1.md",
    content: "# 新知识\n",
  },
]);
assert.deepEqual(calls.slice(publishStart).filter((call) =>
  ["add", "commit", "push"].includes(call.args[0]!) ||
  (call.args[0] === "rev-parse" && call.args[1] === "HEAD"),
), [
  {
    args: ["add", "--", ".workflow-platform/knowledge/knowledge-document-1.md"],
    cwd: projectRoot,
  },
  {
    args: [
      "commit",
      "--only",
      "-m",
      "docs(knowledge): publish knowledge-document-1",
      "--",
      ".workflow-platform/knowledge/knowledge-document-1.md",
    ],
    cwd: projectRoot,
  },
  {
    args: ["push", "--set-upstream", "origin", "main"],
    cwd: projectRoot,
  },
  {
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot,
  },
]);
