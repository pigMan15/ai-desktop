import { useEffect, useState } from "react";

import { ApprovalInbox } from "../features/approvals/ApprovalInbox";
import { ArtifactsPage } from "../features/artifacts/ArtifactsPage";
import { GatesPage } from "../features/gates/GatesPage";
import { ProjectDashboard } from "../features/projects/ProjectDashboard";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { RunDashboard } from "../features/runs/RunDashboard";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TerminalPage } from "../features/terminal/TerminalPage";
import { WorkflowViewer } from "../features/workflow/WorkflowViewer";
import { Navigation } from "./navigation";
import { loadWorkbenchState, type RuntimeWorkbenchState } from "./runtimeClient";

export function App() {
  const [state, setState] = useState<RuntimeWorkbenchState | null>(null);

  useEffect(() => {
    let isMounted = true;

    loadWorkbenchState()
      .then((workbenchState) => {
        if (isMounted) {
          setState(workbenchState);
        }
      })
      .catch(() => {
        if (isMounted) {
          setState(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const connectionText =
    state?.connection === "connected" ? "连接状态：已连接" : "连接状态：不可用";
  const runStatus = state?.projection.status ?? "正在加载";

  return (
    <div className="app-shell">
      <Navigation />
      <main className="workbench" aria-labelledby="app-title">
        <header className="workbench-header">
          <div>
            <p className="section-kicker">Renderer UI MVP</p>
            <h1 id="app-title">Renderer UI MVP 工作台</h1>
          </div>
          <div className="run-summary" aria-label="当前运行摘要">
            <span>当前 Run 状态</span>
            <strong>{runStatus}</strong>
            <span>{connectionText}</span>
          </div>
        </header>
        <div className="content-grid">
          <ProjectDashboard state={state} />
          <RunDashboard state={state} />
          <WorkflowViewer />
          <TerminalPage />
          <GatesPage state={state} />
          <ArtifactsPage state={state} />
          <ApprovalInbox state={state} />
          <RecoveryPage state={state} />
          <SettingsPage />
        </div>
      </main>
    </div>
  );
}
