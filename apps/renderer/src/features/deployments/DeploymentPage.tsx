import { useEffect, useMemo, useState } from "react";

import {
  RuntimeClientError,
  type DeploymentOutputEvent,
  type DeploymentSummary,
} from "../../app/runtimeClient";
import { buildRunDetailHash, type RunContext } from "../../app/routes";
import { createScopedPageState, reduceScopedPage, scopedContextKey, type ScopedPageState } from "../runs/scopedPageModel";

export type DeploymentClient = {
  listDeployments: (projectId: string, runId: string, signal?: AbortSignal) => Promise<DeploymentSummary[]>;
  listDeploymentOutput: (projectId: string, runId: string, deploymentId: string, afterSequence?: number, signal?: AbortSignal) => Promise<DeploymentOutputEvent[]>;
  cancelDeployment: (projectId: string, runId: string, deploymentId: string, now: string, signal?: AbortSignal) => Promise<DeploymentSummary>;
};

type Props = {
  context: RunContext;
  client: DeploymentClient;
  now?: () => string;
};

const defaultNow = () => new Date().toISOString();

export function DeploymentPage({ context, client, now = defaultNow }: Props) {
  const contextKey = scopedContextKey(context);
  const [state, setState] = useState<ScopedPageState<DeploymentSummary[]>>(() => createScopedPageState(context));
  const [selectedId, setSelectedId] = useState<string>("");
  const [output, setOutput] = useState<DeploymentOutputEvent[]>([]);
  const [outputError, setOutputError] = useState<RuntimeClientError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const generation = state.generation + 1;
    setState((current) => reduceScopedPage(current, {
      type: "load-started", contextKey, generation, retainData: current.data !== null,
    }));
    void client.listDeployments(context.projectId, context.runId, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setState((current) => reduceScopedPage(current, {
          type: "load-succeeded", contextKey, generation, data: items, at: now(),
        }));
        setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((current) => reduceScopedPage(current, {
            type: "load-failed", contextKey, generation, error: asRuntimeError(error),
          }));
        }
      });
    return () => controller.abort();
  }, [client, context.projectId, context.runId, contextKey, now]);

  const selected = useMemo(() => state.data?.find((item) => item.id === selectedId) ?? null, [selectedId, state.data]);

  useEffect(() => {
    if (!selected) {
      setOutput([]);
      setOutputError(null);
      return;
    }
    const controller = new AbortController();
    setOutputError(null);
    void client.listDeploymentOutput(context.projectId, context.runId, selected.id, 0, controller.signal)
      .then((events) => { if (!controller.signal.aborted) setOutput(events); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setOutputError(asRuntimeError(error)); });
    return () => controller.abort();
  }, [client, context.projectId, context.runId, selected?.id]);

  async function cancelSelected() {
    if (!selected || state.readOnly || selected.status === "COMPLETED" || selected.status === "CANCELLED") return;
    const controller = new AbortController();
    setState((current) => ({ ...current, phase: "acting", error: null }));
    try {
      const updated = await client.cancelDeployment(context.projectId, context.runId, selected.id, now(), controller.signal);
      setState((current) => ({
        ...current,
        phase: "ready",
        data: current.data?.map((item) => item.id === updated.id ? updated : item) ?? [updated],
        error: null,
      }));
    } catch (error) {
      setState((current) => ({ ...current, phase: current.data ? "ready" : "error", error: asRuntimeError(error), stale: Boolean(current.data) }));
    }
  }

  const canCancel = Boolean(selected && !state.readOnly && selected.status !== "COMPLETED" && selected.status !== "CANCELLED");
  return (
    <section className="panel page-workspace page-deployments" aria-labelledby="deployments-title">
      <div className="panel-heading">
        <div><p className="section-kicker">Deployments</p><h2 id="deployments-title">部署</h2></div>
        <span className="status-pill">{state.phase === "loading" ? "加载中" : state.phase === "not-found" ? "Run 不存在" : state.readOnly ? "只读" : `${state.data?.length ?? 0} 项`}</span>
      </div>
      <a className="quiet-button" href={buildRunDetailHash(context.runId)}>返回 Run</a>
      {state.error && !state.data ? <p role="alert" className="body-copy">{state.error.message}</p> : null}
      {state.data && state.data.length > 0 ? (
        <div className="deployment-layout">
          <label>部署记录
            <select aria-label="部署记录" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {state.data.map((item) => <option key={item.id} value={item.id}>{item.nodeId} / {item.status}</option>)}
            </select>
          </label>
          {selected ? <article className="gate-record">
            <div className="panel-heading"><strong>{selected.id}</strong><span className="status-pill">{selected.status}</span></div>
            <dl className="facts"><div><dt>节点</dt><dd>{selected.nodeId}</dd></div><div><dt>工作区</dt><dd>{selected.cwd}</dd></div><div><dt>进程</dt><dd>{selected.pid ?? "-"}</dd></div></dl>
            <div className="button-row"><button className="quiet-button" disabled={!canCancel} onClick={() => void cancelSelected()}>取消部署</button></div>
            {outputError ? <p role="alert" className="body-copy">{outputError.message}</p> : null}
            <pre className="terminal-readout" aria-label="部署输出">{output.map((event) => event.data).join("")}</pre>
          </article> : null}
        </div>
      ) : state.phase === "ready" ? <p className="body-copy">当前 Run 没有部署记录。</p> : null}
    </section>
  );
}

function asRuntimeError(error: unknown): RuntimeClientError {
  return error instanceof RuntimeClientError ? error : new RuntimeClientError(null, "RUNTIME_ERROR", error instanceof Error ? error.message : String(error), undefined, null);
}
