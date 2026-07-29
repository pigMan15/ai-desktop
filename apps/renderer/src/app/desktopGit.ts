import type { GitWorkspaceStatus, GitWorktree } from "../features/projects/GitWorkspacePanel";

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

export type DesktopGitApi = {
  status(projectRoot: string): Promise<GitWorkspaceStatus>;
  listWorktrees(projectRoot: string): Promise<GitWorktree[]>;
  createWorktree(projectRoot: string, branch: string): Promise<GitWorktree>;
  removeWorktree(projectRoot: string, worktreePath: string): Promise<void>;
  mergeBack(projectRoot: string, sourceBranch: string): Promise<GitWorkspaceStatus>;
  push(projectRoot: string): Promise<void>;
  previewKnowledgeDocument(
    projectRoot: string,
    documentId: string,
    markdown: string,
  ): Promise<KnowledgeDocumentPreview>;
  publishKnowledgeDocument(
    projectRoot: string,
    documentId: string,
    markdown: string,
  ): Promise<PublishedKnowledgeDocument>;
};

export function desktopGitApi(): DesktopGitApi | null {
  return (window as typeof window & { workflowGit?: DesktopGitApi }).workflowGit ?? null;
}
