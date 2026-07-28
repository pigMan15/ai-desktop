import {
  runtimeHealth,
  type RuntimeHealth,
  type RuntimeLogEntry,
  type RuntimeStatus
} from "../src/main/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type Expect<Value extends true> = Value;

type RuntimeHealthResult = ReturnType<typeof runtimeHealth>;

type _RuntimeHealthContract = Expect<
  Equal<RuntimeHealthResult, RuntimeHealth>
>;

type _RuntimeHealthShape = Expect<
  Equal<RuntimeHealth, { status: "ok"; service: "workflow-runtime" }>
>;

type _GlobalRuntimeHealthContract = Expect<
  Equal<ReturnType<Window["workflowRuntime"]["health"]>, Promise<RuntimeHealth>>
>;

type _RuntimeStatusShape = Expect<
  Equal<
    RuntimeStatus,
    {
      mode: "external" | "managed";
      state: "stopped" | "starting" | "ready" | "failed";
      url: string;
      port: number;
      pid: number | null;
      lastError: string | null;
    }
  >
>;

type _RuntimeLogEntryShape = Expect<
  Equal<RuntimeLogEntry, { level: "info" | "error"; message: string; createdAt: string }>
>;

type _GlobalRuntimeStatusContract = Expect<
  Equal<ReturnType<Window["workflowRuntime"]["status"]>, Promise<RuntimeStatus>>
>;

type _GlobalRuntimeRestartContract = Expect<
  Equal<ReturnType<Window["workflowRuntime"]["restart"]>, Promise<RuntimeStatus>>
>;

type _GlobalRuntimeLogsContract = Expect<
  Equal<ReturnType<Window["workflowRuntime"]["logs"]>, Promise<RuntimeLogEntry[]>>
>;
