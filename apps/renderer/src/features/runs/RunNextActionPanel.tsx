import type { ReactNode } from "react";

import type { RunGuidance, RunGuidanceAction } from "./runWorkbenchModel";

type RunNextActionPanelProps = {
  guidance: RunGuidance;
  onAction: (action: RunGuidanceAction) => void;
  renderInput?: (action: RunGuidanceAction) => ReactNode;
};

export function RunNextActionPanel({
  guidance,
  onAction,
  renderInput,
}: RunNextActionPanelProps) {
  const primaryAction = guidance.readOnly ? null : guidance.primaryAction;

  const actionInput = (action: RunGuidanceAction) => {
    if (action.requiredInput === "none" || !renderInput) return null;

    return <div className="run-next-action-input">{renderInput(action)}</div>;
  };

  return (
    <section className="run-next-action-panel" aria-label="下一步操作">
      <h3>下一步操作</h3>

      {primaryAction ? (
        <div className="run-next-action-content">
          <div className="run-next-action-primary" data-testid="run-next-action-primary">
            <button
              type="button"
              className="run-next-action-primary-button"
              data-action-id={primaryAction.id}
              onClick={() => onAction(primaryAction)}
            >
              {primaryAction.label}
            </button>
            <p className="run-next-action-result">{primaryAction.result}</p>
            {actionInput(primaryAction)}
          </div>

          {guidance.secondaryActions.length > 0 ? (
            <div className="run-next-action-secondary" data-testid="run-next-action-secondary">
              {guidance.secondaryActions.map((action) => (
                <div key={action.id} className="run-next-action-secondary-action">
                  <button
                    type="button"
                    className="run-next-action-secondary-button"
                    data-action-id={action.id}
                    onClick={() => onAction(action)}
                  >
                    {action.label}
                  </button>
                  {actionInput(action)}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="run-next-action-message">
          {guidance.waitingMessage ?? guidance.blockingReason?.message ?? "当前没有可执行操作。"}
        </p>
      )}
    </section>
  );
}
