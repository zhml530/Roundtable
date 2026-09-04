import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectChannelArtifacts, readChannelArtifact } from "./channel-artifacts.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it("discovers supporting documents and refuses paths outside their workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "channel-artifacts-")); roots.push(root);
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  writeFileSync(join(cwd, "recommendation.md"), "Use a keyframe baseline first.");
  writeFileSync(join(cwd, "credentials.json"), "never list");
  writeFileSync(join(root, "outside.md"), "outside");
  const artifacts = collectChannelArtifacts([{ threadId: "research", cwd, output: "recommendation.md" }], Date.now() + 1000);
  expect(artifacts).toEqual([{ label: "recommendation.md", path: join(cwd, "recommendation.md"), threadId: "research" }]);
  expect(readChannelArtifact(cwd, artifacts[0]!.path).text).toContain("keyframe");
  expect(() => readChannelArtifact(cwd, join(root, "outside.md"))).toThrow("outside");
});
