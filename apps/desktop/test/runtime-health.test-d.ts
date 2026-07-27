import { runtimeHealth, type RuntimeHealth } from "../src/main/runtime.js";

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
