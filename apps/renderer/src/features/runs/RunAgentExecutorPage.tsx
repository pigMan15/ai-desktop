import { ArrowLeft } from "lucide-react";
import { buildRunDetailHash } from "../../app/routes";
import { RunAgentExecutor, type RunAgentExecutorProps } from "./RunAgentExecutor";

export type RunAgentExecutorPageProps = Omit<
  RunAgentExecutorProps,
  "selectedJobId" | "showFullScreenLink" | "fullScreen"
> & {
  jobId: string;
};

export function RunAgentExecutorPage({ jobId, ...props }: RunAgentExecutorPageProps) {
  return (
    <section className="page-runs run-agent-executor-page" aria-label="Agent 全屏执行器">
      <header className="run-agent-executor-page-header">
        <a href={buildRunDetailHash(props.runId)}>
          <ArrowLeft size={15} aria-hidden="true" />
          返回 Run
        </a>
        <div>
          <p className="eyebrow">Run Agent</p>
          <h1>Agent 执行器</h1>
          <code title={props.runId}>{props.runId}</code>
        </div>
      </header>
      <RunAgentExecutor {...props} selectedJobId={jobId} fullScreen />
    </section>
  );
}
