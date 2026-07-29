import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const managedWorktreeDirectory = ".workflow-platform";
const managedWorktreeLeaf = "worktrees";

export type GitCommandRunner = (args: string[], cwd: string) => Promise<string>;

export type KnowledgeFileStore = {
  ensureDirectory(directoryPath: string): Promise<void>;
  readText(filePath: string): Promise<string | null>;
  writeText(filePath: string, content: string): Promise<void>;
};

export type GitWorkspaceStatus = {
  rootPath: string;
  branch: string | null;
  detachedHead: boolean;
  dirty: boolean;
  changes: string[];
};

export type GitWorktree = {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
};

export type KnowledgeDocumentPreview = {
  relativePath: string;
  previousContent: string;
  nextContent: string;
};

export type PublishedKnowledgeDocument = {
  branch: string;
  relativePath: string;
  commitHash: string;
};

export class GitWorkspaceManager {
  private readonly runGit: GitCommandRunner;
  private readonly knowledgeFiles: KnowledgeFileStore;

  constructor({
    runGit = defaultGitCommandRunner,
    knowledgeFiles = defaultKnowledgeFileStore,
  }: {
    runGit?: GitCommandRunner;
    knowledgeFiles?: KnowledgeFileStore;
  } = {}) {
    this.runGit = runGit;
    this.knowledgeFiles = knowledgeFiles;
  }

  async status(projectRoot: string): Promise<GitWorkspaceStatus> {
    const rootPath = path.resolve(projectRoot);
    await this.requireRepository(rootPath);
    const branch = await this.currentBranch(rootPath);
    const rawChanges = await this.runGit(["status", "--porcelain=v1"], rootPath);
    const changes = rawChanges
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      rootPath,
      branch,
      detachedHead: branch === null,
      dirty: changes.length > 0,
      changes,
    };
  }

  async listWorktrees(projectRoot: string): Promise<GitWorktree[]> {
    const rootPath = path.resolve(projectRoot);
    await this.requireRepository(rootPath);
    const output = await this.runGit(["worktree", "list", "--porcelain"], rootPath);
    return parseWorktreeList(output);
  }

  async createWorktree(projectRoot: string, branch: string): Promise<GitWorktree> {
    const rootPath = path.resolve(projectRoot);
    validateBranchName(branch);
    await this.requireCleanBranch(rootPath);
    const worktreePath = managedWorktreePath(rootPath, branch);

    await this.runGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], rootPath);
    return { path: worktreePath, branch, head: null, bare: false };
  }

  async removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
    const rootPath = path.resolve(projectRoot);
    await this.requireRepository(rootPath);
    const resolvedWorktreePath = path.resolve(worktreePath);
    const managedRoot = path.join(rootPath, managedWorktreeDirectory, managedWorktreeLeaf);
    if (!isSubPath(managedRoot, resolvedWorktreePath) || resolvedWorktreePath === managedRoot) {
      throw new Error("只能清理本软件创建的受控 worktree。");
    }
    await this.runGit(["worktree", "remove", resolvedWorktreePath], rootPath);
  }

  async mergeBack(projectRoot: string, sourceBranch: string): Promise<GitWorkspaceStatus> {
    const rootPath = path.resolve(projectRoot);
    validateBranchName(sourceBranch);
    const target = await this.requireCleanBranch(rootPath);
    if (target === sourceBranch) {
      throw new Error("不能将当前分支合并到自身。");
    }
    await this.runGit(["merge-base", "--is-ancestor", target, sourceBranch], rootPath);
    await this.runGit(["merge", "--ff-only", sourceBranch], rootPath);
    return this.status(rootPath);
  }

  async push(projectRoot: string): Promise<void> {
    const rootPath = path.resolve(projectRoot);
    const branch = await this.requireCleanBranch(rootPath);
    await this.runGit(["push", "--set-upstream", "origin", branch], rootPath);
  }

  async previewKnowledgeDocument(
    projectRoot: string,
    documentId: string,
    markdown: string,
  ): Promise<KnowledgeDocumentPreview> {
    const rootPath = path.resolve(projectRoot);
    await this.requireRepository(rootPath);
    const target = knowledgeDocumentPath(rootPath, documentId);
    return {
      relativePath: target.relativePath,
      previousContent: (await this.knowledgeFiles.readText(target.absolutePath)) ?? "",
      nextContent: markdown,
    };
  }

  async publishKnowledgeDocument(
    projectRoot: string,
    documentId: string,
    markdown: string,
  ): Promise<PublishedKnowledgeDocument> {
    const rootPath = path.resolve(projectRoot);
    const branch = await this.requireCleanBranch(rootPath);
    const target = knowledgeDocumentPath(rootPath, documentId);
    await this.knowledgeFiles.ensureDirectory(path.dirname(target.absolutePath));
    await this.knowledgeFiles.writeText(target.absolutePath, markdown);
    await this.runGit(["add", "--", target.relativePath], rootPath);
    await this.runGit(
      [
        "commit",
        "--only",
        "-m",
        `docs(knowledge): publish ${documentId}`,
        "--",
        target.relativePath,
      ],
      rootPath,
    );
    await this.runGit(["push", "--set-upstream", "origin", branch], rootPath);
    const commitHash = (await this.runGit(["rev-parse", "HEAD"], rootPath)).trim();
    if (!commitHash) {
      throw new Error("Git 提交成功后无法读取提交哈希。");
    }
    return { branch, relativePath: target.relativePath, commitHash };
  }

  private async requireRepository(rootPath: string): Promise<void> {
    const result = (await this.runGit(["rev-parse", "--is-inside-work-tree"], rootPath)).trim();
    if (result !== "true") {
      throw new Error("项目目录不是 Git 工作树。");
    }
  }

  private async currentBranch(rootPath: string): Promise<string | null> {
    try {
      const branch = (await this.runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], rootPath)).trim();
      return branch || null;
    } catch {
      return null;
    }
  }

  private async requireCleanBranch(rootPath: string): Promise<string> {
    const workspace = await this.status(rootPath);
    if (workspace.detachedHead || !workspace.branch) {
      throw new Error("当前处于分离 HEAD 状态，不能执行此操作。");
    }
    if (workspace.dirty) {
      throw new Error("工作区存在未提交变更，不能执行此操作。");
    }
    return workspace.branch;
  }
}

async function defaultGitCommandRunner(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

const defaultKnowledgeFileStore: KnowledgeFileStore = {
  async ensureDirectory(directoryPath) {
    await mkdir(directoryPath, { recursive: true });
  },
  async readText(filePath) {
    try {
      return await readFile(filePath, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  },
  async writeText(filePath, content) {
    await writeFile(filePath, content, "utf-8");
  },
};

function validateBranchName(branch: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("@{")
  ) {
    throw new Error("非法 Git 分支名称。");
  }
}

function knowledgeDocumentPath(
  projectRoot: string,
  documentId: string,
): { absolutePath: string; relativePath: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(documentId)) {
    throw new Error("非法知识文档标识。");
  }
  const relativePath = path.join(managedWorktreeDirectory, "knowledge", `${documentId}.md`);
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!isSubPath(projectRoot, absolutePath)) {
    throw new Error("知识文档路径越界。");
  }
  return { absolutePath, relativePath: relativePath.replaceAll("\\", "/") };
}

function managedWorktreePath(projectRoot: string, branch: string): string {
  const safeBranchSegment = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const managedRoot = path.join(projectRoot, managedWorktreeDirectory, managedWorktreeLeaf);
  const candidate = path.resolve(managedRoot, safeBranchSegment);
  if (!isSubPath(managedRoot, candidate)) {
    throw new Error("受控 worktree 路径越界。");
  }
  return candidate;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSubPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseWorktreeList(output: string): GitWorktree[] {
  const entries = output.trim().split(/\r?\n\r?\n/).filter(Boolean);
  return entries.map((entry) => {
    const fields = new Map(
      entry
        .split(/\r?\n/)
        .map((line) => {
          const [key, ...rest] = line.split(" ");
          return [key, rest.join(" ")] as const;
        }),
    );
    return {
      path: fields.get("worktree") ?? "",
      branch: fields.get("branch")?.replace(/^refs\/heads\//, "") ?? null,
      head: fields.get("HEAD") ?? null,
      bare: fields.has("bare"),
    };
  });
}
