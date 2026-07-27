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

export function App() {
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
            <strong>waiting_for_gate</strong>
          </div>
        </header>
        <div className="content-grid">
          <ProjectDashboard />
          <RunDashboard />
          <WorkflowViewer />
          <TerminalPage />
          <GatesPage />
          <ArtifactsPage />
          <ApprovalInbox />
          <RecoveryPage />
          <SettingsPage />
        </div>
      </main>
    </div>
  );
}
