import { useEffect, useRef, useState } from "react";

import type { Actor, CreateRunRequest, WorkspaceMode } from "@workflow-platform/contracts";
import { RuntimeClientError, type ScopedCreateRunResponse } from "../../app/runtimeClient";

type NewRunPageProps = {
  project: { id: string; name: string };
  binding: { workflowVersionId: string; workflowName: string } | null;
  workspaces: Array<{ path: string; branch: string; isMain: boolean }>;
  actor: Actor;
  createIdempotencyKey?: () => string;
  onCreate(input: {
    idempotencyKey: string;
    request: CreateRunRequest;
  }): Promise<ScopedCreateRunResponse>;
  onCreated(runId: string): void;
  onCancel(): void;
  onOpenWorkflowLibrary(): void;
};

type FormError = { message: string; correlationId?: string | null };

export function NewRunPage({
  project,
  binding,
  workspaces,
  actor,
  createIdempotencyKey = defaultIdempotencyKey,
  onCreate,
  onCreated,
  onCancel,
  onOpenWorkflowLibrary,
}: NewRunPageProps) {
  const [title, setTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [parametersText, setParametersText] = useState("{}");
  const [workspacePath, setWorkspacePath] = useState(workspaces[0]?.path ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("write");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    if (workspaces.some((workspace) => workspace.path === workspacePath)) return;
    setWorkspacePath(workspaces[0]?.path ?? "");
  }, [workspaces, workspacePath]);

  if (!binding) {
    return (
      <section className="page-runs new-run-page" aria-label="新建 Run">
        <header className="new-run-heading">
          <div>
            <p className="section-kicker">{project.name}</p>
            <h2>新建 Run</h2>
          </div>
        </header>
        <div className="new-run-recovery" role="status">
          <strong>当前项目尚未绑定工作流</strong>
          <span>先选择并绑定一个工作流版本，再创建 Run。</span>
          <div className="button-row">
            <button className="quiet-button" type="button" onClick={onOpenWorkflowLibrary}>前往工作流库</button>
            <button className="quiet-button" type="button" onClick={onCancel}>返回 Run 列表</button>
          </div>
        </div>
      </section>
    );
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = validateForm(title, parametersText, workspacePath);
    if ("error" in parsed) {
      setError({ message: parsed.error });
      return;
    }

    setPending(true);
    setSubmitted(true);
    setError(null);
    const fingerprint = JSON.stringify({
      projectId: project.id,
      workflowVersionId: binding.workflowVersionId,
      title: title.trim(),
      taskGoal: taskGoal.trim(),
      parametersText: parametersText.trim(),
      workspacePath,
      workspaceMode,
    });
    if (idempotencyRef.current?.fingerprint !== fingerprint) {
      idempotencyRef.current = { fingerprint, key: createIdempotencyKey() };
    }

    const request: CreateRunRequest = {
      workflowVersionId: binding.workflowVersionId,
      title: title.trim(),
      ...(taskGoal.trim() ? { taskGoal: taskGoal.trim() } : {}),
      parameters: parsed.parameters,
      executionWorkspace: { path: workspacePath, mode: workspaceMode },
      actor,
    };

    try {
      const result = await onCreate({
        idempotencyKey: idempotencyRef.current.key,
        request,
      });
      idempotencyRef.current = null;
      onCreated(result.run.id);
    } catch (caught: unknown) {
      const runtimeError = caught instanceof RuntimeClientError ? caught : null;
      setError({
        message: runtimeError?.message ?? (caught instanceof Error ? caught.message : "创建 Run 失败"),
        correlationId: runtimeError?.correlationId,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="page-runs new-run-page" aria-label="新建 Run">
      <header className="new-run-heading">
        <div>
          <p className="section-kicker">{project.name}</p>
          <h2>新建 Run</h2>
          <p className="run-list-context">已绑定：{binding.workflowName}</p>
        </div>
      </header>

      <dl className="new-run-context">
        <div><dt>项目</dt><dd>{project.name}</dd></div>
        <div><dt>工作流版本</dt><dd>{binding.workflowName} · {binding.workflowVersionId}</dd></div>
      </dl>

      {workspaces.length === 0 ? (
        <p className="new-run-workspace-warning" role="status">
          没有可用的执行工作区，请先在项目页创建或发现 Git worktree。
        </p>
      ) : null}

      <form className="new-run-form" noValidate onSubmit={submit}>
        <label>
          Run 名称
          <input
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          运行目标
          <textarea value={taskGoal} onChange={(event) => setTaskGoal(event.target.value)} />
        </label>
        <label>
          运行参数
          <textarea
            className="new-run-parameters"
            value={parametersText}
            spellCheck={false}
            onChange={(event) => setParametersText(event.target.value)}
          />
        </label>
        <label>
          执行工作区
          <select
            value={workspacePath}
            disabled={workspaces.length === 0}
            onChange={(event) => setWorkspacePath(event.target.value)}
          >
            {workspaces.length === 0 ? <option value="">无可用工作区</option> : null}
            {workspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>
                {workspace.isMain ? "main" : workspace.branch} · {workspace.path}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="new-run-mode">
          <legend>工作区模式</legend>
          <label>
            <input
              type="radio"
              name="workspace-mode"
              value="write"
              checked={workspaceMode === "write"}
              onChange={() => setWorkspaceMode("write")}
            />
            可写
          </label>
          <label>
            <input
              type="radio"
              name="workspace-mode"
              value="read"
              checked={workspaceMode === "read"}
              onChange={() => setWorkspaceMode("read")}
            />
            只读
          </label>
        </fieldset>

        {error ? (
          <div className="new-run-error" role="alert">
            <strong>{error.message}</strong>
            {error.correlationId ? <code>{error.correlationId}</code> : null}
          </div>
        ) : null}

        <div className="new-run-actions">
          <button className="run-next-action-primary-button" type="submit" disabled={pending || workspaces.length === 0}>
            {pending ? "正在创建..." : submitted ? "重试创建" : "创建 Run"}
          </button>
          <button className="quiet-button" type="button" disabled={pending} onClick={onCancel}>取消</button>
        </div>
      </form>
    </section>
  );
}

function validateForm(title: string, parametersText: string, workspacePath: string):
  | { parameters: Record<string, unknown> }
  | { error: string } {
  if (!title.trim()) return { error: "请输入 Run 名称" };
  if (title.trim().length > 120) return { error: "Run 名称不能超过 120 个字符" };
  if (!workspacePath) return { error: "请选择执行工作区" };
  try {
    const parameters: unknown = JSON.parse(parametersText);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      return { error: "运行参数必须是 JSON 对象" };
    }
    return { parameters: parameters as Record<string, unknown> };
  } catch {
    return { error: "运行参数不是有效的 JSON" };
  }
}

function defaultIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
