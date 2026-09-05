import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function subject() {
  const root = mkdtempSync(join(tmpdir(), "roundtable-channel-state-"));
  roots.push(root);
  vi.stubEnv("OMB_DATA_DIR", root);
  vi.resetModules();
  return import("./channel-project-state.ts");
}

describe("Channel project state", () => {
  it("atomically stores and reloads a bounded Roundtable-owned checkpoint", async () => {
    const state = await subject();
    const written = state.writeChannelProjectState("channel-1", `# Project State\r\n\r\n${"界".repeat(20_000)}`);
    expect(written.path).toBe(join(process.env.OMB_DATA_DIR!, "channel-projects", "channel-1", "PROJECT_STATE.md"));
    expect(written.bytes).toBeLessThanOrEqual(state.PROJECT_STATE_MAX_BYTES);
    expect(readFileSync(written.path, "utf8")).not.toContain("�");
    expect(state.loadChannelProjectState("channel-1")).toMatch(/^# Project State/);
  });

  it("rejects traversal and treats a missing checkpoint as empty", async () => {
    const state = await subject();
    expect(state.loadChannelProjectState("new-channel")).toBeNull();
    expect(() => state.writeChannelProjectState("../outside", "nope")).toThrow("invalid Channel id");
  });
});
