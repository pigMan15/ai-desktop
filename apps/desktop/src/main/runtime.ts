export type RuntimeHealth = {
  status: "ok";
  service: "workflow-runtime";
};

export function runtimeHealth(): RuntimeHealth {
  return { status: "ok", service: "workflow-runtime" };
}
