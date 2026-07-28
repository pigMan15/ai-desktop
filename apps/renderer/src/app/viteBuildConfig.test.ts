import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Vite production build", () => {
  it("uses relative asset URLs so Electron file pages can load the renderer", () => {
    const configPath = path.resolve(process.cwd(), "vite.config.ts");
    const configSource = readFileSync(configPath, "utf8");

    expect(configSource).toContain('base: "./"');
  });
});
