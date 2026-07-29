import { expect, it } from "vitest";

import { diffArtifactText } from "./artifactDiff";

it("marks added and removed artifact lines for review", () => {
  expect(diffArtifactText("计划\n旧步骤\n", "计划\n新步骤\n")).toEqual([
    { kind: "unchanged", text: "计划" },
    { kind: "removed", text: "旧步骤" },
    { kind: "added", text: "新步骤" },
  ]);
});
