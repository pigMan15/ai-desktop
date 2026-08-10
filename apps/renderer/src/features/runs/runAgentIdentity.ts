export type AgentIconName = "gem" | "sparkles" | "hexagon" | "orbit";

export type AgentIdentity = {
  name: string;
  displayName: string;
  icon: AgentIconName;
  color: string;
};

const CODENAMES = [
  "Lovelace",
  "Pasteur",
  "Hubble",
  "Kierkegaard",
  "Curie",
  "Turing",
  "Galileo",
  "Darwin",
  "Tesla",
  "Feynman",
  "Hopper",
  "Kepler",
  "Faraday",
  "Noether",
  "Goodall",
  "Sagan",
  "Franklin",
  "Mendel",
  "Newton",
  "Euclid",
] as const;

const ICONS: AgentIconName[] = ["gem", "sparkles", "hexagon", "orbit"];

// These accents retain readable contrast on the dark Run surfaces.
const COLORS = [
  "#c4b5fd",
  "#f9a8d4",
  "#7dd3fc",
  "#86efac",
  "#fde68a",
  "#fdba74",
  "#a5f3fc",
  "#fda4af",
] as const;

function hashJobId(jobId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < jobId.length; index += 1) {
    hash ^= jobId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function agentIdentity(jobId: string): AgentIdentity {
  const hash = hashJobId(jobId);
  const name = CODENAMES[hash % CODENAMES.length];
  return {
    name,
    displayName: name,
    icon: ICONS[Math.floor(hash / CODENAMES.length) % ICONS.length],
    color: COLORS[Math.floor(hash / (CODENAMES.length * ICONS.length)) % COLORS.length],
  };
}

export function agentIdentities(jobIds: string[]): AgentIdentity[] {
  const identities = jobIds.map((jobId) => agentIdentity(jobId));
  const membersByName = new Map<string, string[]>();
  for (const jobId of jobIds) {
    const name = agentIdentity(jobId).name;
    membersByName.set(name, [...(membersByName.get(name) ?? []), jobId]);
  }
  const rankByJobId = new Map<string, number>();
  for (const members of membersByName.values()) {
    [...members].sort((left, right) => left.localeCompare(right)).forEach((jobId, index) => {
      rankByJobId.set(jobId, index);
    });
  }
  return identities.map((identity, index) => {
    const rank = rankByJobId.get(jobIds[index]) ?? 0;
    return rank === 0 ? identity : { ...identity, displayName: `${identity.name} ${rank + 1}` };
  });
}
