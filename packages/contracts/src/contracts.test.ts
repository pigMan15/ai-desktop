import { ERROR_CODES, NODE_KINDS, RUN_EVENT_TYPES } from "./index.js";

function it(name: string, test: () => void): void {
  try {
    test();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function expect<T>(actual: readonly T[]): { toContain(expected: T): void } {
  return {
    toContain(expected: T): void {
      if (!actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
  };
}

it("exports stable workflow and runtime constants", () => {
  expect(NODE_KINDS).toContain("agent");
  expect(RUN_EVENT_TYPES).toContain("HUMAN_APPROVED");
  expect(ERROR_CODES).toContain("REVISION_CONFLICT");
});
