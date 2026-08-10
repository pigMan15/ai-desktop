import { useCallback, useEffect, useRef, useState } from "react";

import type { KnowledgeChangeSetDetail } from "@workflow-platform/contracts";
import { RuntimeClientError, type KnowledgeClient } from "./knowledgeClient";

export type KnowledgeChangeSetPageState = {
  changeSet: KnowledgeChangeSetDetail | null;
  loading: boolean;
  error: string | null;
  operationMessage: string | null;
};

export function useKnowledgeChangeSetPage(
  client: KnowledgeClient,
  projectId: string | null,
  runId: string | null,
  changeSetId: string | null,
): {
  state: KnowledgeChangeSetPageState;
  refresh: () => void;
  runAction: <T>(action: (input: { actor: { id: string; type: "human"; source: "renderer"; trusted: boolean }; expectedRevision: string; now: string }) => Promise<T>, label: string) => Promise<T | null>;
} {
  const [state, setState] = useState<KnowledgeChangeSetPageState>({
    changeSet: null,
    loading: true,
    error: null,
    operationMessage: null,
  });
  const generation = useRef(0);

  const refresh = useCallback(() => {
    if (!projectId || !runId || !changeSetId) {
      setState((current) => ({ ...current, loading: false, changeSet: null }));
      return;
    }
    const current = ++generation.current;
    setState((currentState) => ({ ...currentState, loading: true, error: null }));
    client
      .getChangeSet(projectId, runId, changeSetId)
      .then((changeSet) => {
        if (generation.current === current) {
          setState({ changeSet, loading: false, error: null, operationMessage: null });
        }
      })
      .catch((caught: unknown) => {
        if (generation.current === current) {
          setState((currentState) => ({
            ...currentState,
            loading: false,
            error: caught instanceof RuntimeClientError ? caught.message : "加载变更集失败",
          }));
        }
      });
  }, [client, projectId, runId, changeSetId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeStatus = state.changeSet?.status;
  useEffect(() => {
    if (activeStatus !== "GENERATING" && activeStatus !== "APPLYING") {
      return;
    }
    const timer = setInterval(() => {
      refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [activeStatus, refresh]);

  const runAction = useCallback(
    async <T,>(
      action: (input: { actor: { id: string; type: "human"; source: "renderer"; trusted: boolean }; expectedRevision: string; now: string }) => Promise<T>,
      label: string,
    ): Promise<T | null> => {
      const changeSet = state.changeSet;
      if (!changeSet || !projectId || !runId) return null;
      try {
        const result = await action({
          actor: { id: "renderer-user", type: "human", source: "renderer", trusted: true },
          expectedRevision: changeSet.revision,
          now: new Date().toISOString(),
        });
        setState((currentState) => ({ ...currentState, operationMessage: `${label}成功` }));
        refresh();
        return result;
      } catch (caught: unknown) {
        setState((currentState) => ({
          ...currentState,
          error: caught instanceof RuntimeClientError ? caught.message : `${label}失败`,
        }));
        return null;
      }
    },
    [client, projectId, runId, refresh, state.changeSet],
  );

  return { state, refresh, runAction };
}
