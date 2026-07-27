export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "WORKFLOW_NOT_FOUND",
  "RUN_NOT_FOUND",
  "REVISION_CONFLICT",
  "RUNTIME_UNAVAILABLE",
  "UNAUTHORIZED_ACTION",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
