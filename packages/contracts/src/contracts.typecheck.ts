import type { NodeKind, RequirementSpec, RunEventType, TransitionResult } from "./index.js";

const plannedNodeKind: NodeKind = "agent";
const plannedRunEventType: RunEventType = "HUMAN_APPROVED";
const plannedRequirement: RequirementSpec = {
  type: "gate",
  gateId: "security-review",
  required: true,
};

void plannedNodeKind;
void plannedRunEventType;
void plannedRequirement;

// @ts-expect-error NodeKind is limited to the planned node kind constants.
const invalidNodeKind: NodeKind = "manual";

// @ts-expect-error RunEventType is limited to the planned runtime event constants.
const invalidRunEventType: RunEventType = "RUN_STARTED";

const invalidRequirementFieldMix: RequirementSpec = {
  type: "artifact",
  // @ts-expect-error RequirementSpec artifact requirements need artifact fields, not gate fields.
  gateId: "security-review",
  required: true,
};

const invalidRequirementKind: RequirementSpec = {
  // @ts-expect-error RequirementSpec only accepts the planned discriminant values.
  type: "checkpoint",
  required: true,
};

// @ts-expect-error TransitionResult requires run, revision, allowedActions, blockingReasons, and emittedEvents.
const incompleteTransition: TransitionResult = {
  accepted: true,
};

void invalidNodeKind;
void invalidRunEventType;
void invalidRequirementFieldMix;
void invalidRequirementKind;
void incompleteTransition;
