import { describe, expect, it } from "vitest";
import { agentIdentities, agentIdentity } from "./runAgentIdentity";

describe("agentIdentity", () => {
  it("returns a stable codename, icon, and accent color for a Job", () => {
    const first = agentIdentity("job-running-codex");
    expect(first).toEqual(agentIdentity("job-running-codex"));
    expect(first).toMatchObject({
      name: expect.any(String),
      displayName: expect.any(String),
      icon: expect.stringMatching(/^(gem|sparkles|hexagon|orbit)$/),
      color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });
    expect(first.displayName).toBe(first.name);
  });

  it("adds stable suffixes when visible Jobs share a codename", () => {
    const jobIds = Array.from({ length: 40 }, (_, index) => `job-${index}`);
    const identities = agentIdentities(jobIds);

    expect(new Set(identities.map((identity) => identity.displayName)).size).toBe(jobIds.length);
    expect(agentIdentities(jobIds)).toEqual(identities);
    expect(identities.some((identity) => / 2$/.test(identity.displayName))).toBe(true);
  });

  it("only suffixes duplicates while retaining each base identity", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `collision-${index}`);
    const byName = new Map<string, string[]>();
    for (const id of ids) {
      const name = agentIdentity(id).name;
      byName.set(name, [...(byName.get(name) ?? []), id]);
    }
    const group = [...byName.values()].find((members) => members.length >= 3);
    expect(group).toBeDefined();
    const members = group!;
    const identities = agentIdentities(members);
    const sorted = [...members].sort((left, right) => left.localeCompare(right));
    const expectedNames = sorted.map((id, index) => `${agentIdentity(id).name}${index === 0 ? "" : ` ${index + 1}`}`);
    expect(new Map(members.map((id, index) => [id, identities[index].displayName]))).toEqual(
      new Map(sorted.map((id, index) => [id, expectedNames[index]])),
    );
  });

  it("keeps duplicate display names stable when the visible list is reordered", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `reorder-${index}`);
    const grouped = new Map<string, string[]>();
    for (const id of ids) {
      const name = agentIdentity(id).name;
      grouped.set(name, [...(grouped.get(name) ?? []), id]);
    }
    const members = [...grouped.values()].find((group) => group.length >= 2)!;
    const first = new Map(members.map((id, index) => [id, agentIdentities(members)[index].displayName]));
    const reversed = [...members].reverse();
    const second = new Map(reversed.map((id, index) => [id, agentIdentities(reversed)[index].displayName]));
    expect(second).toEqual(first);
  });
});
