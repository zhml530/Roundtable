import { describe, expect, it } from "vitest";
import { createAcpFileChanges } from "./file-changes.ts";

describe("ACP changed file metadata", () => {
  it("merges partial updates and publishes all paths only on success", () => {
    const track = createAcpFileChanges();
    expect(track({ toolCallId: "edit", kind: "edit", locations: [{ path: "src\\a.ts" }] })).toBeUndefined();
    expect(track({ toolCallId: "edit", content: [
      { type: "diff", path: "src\\new.tsx", oldText: null, newText: "new file" },
      { type: "diff", path: "config.yaml", oldText: "old", newText: "new" },
    ] })).toBeUndefined();
    expect(track({ toolCallId: "edit", status: "completed" })).toEqual([
      { path: "src\\new.tsx", kind: "created" },
      { path: "config.yaml", kind: "modified" },
      { path: "src\\a.ts", kind: "modified" },
    ]);
  });

  it("recognizes deletion without checking whether the file still exists", () => {
    const track = createAcpFileChanges();
    expect(track({ toolCallId: "delete", kind: "delete", status: "completed", locations: [{ path: "gone.ts" }] }))
      .toEqual([{ path: "gone.ts", kind: "deleted" }]);
    expect(track({ toolCallId: "patch", status: "completed", content: [
      { type: "diff", path: "old.ts", oldText: "old", newText: null },
      { type: "diff", path: "empty.ts", oldText: "old", newText: "" },
    ] })).toEqual([{ path: "old.ts", kind: "deleted" }, { path: "empty.ts", kind: "modified" }]);
  });

  it("ignores reads, shell commands, prose and failed/proposed edits", () => {
    const track = createAcpFileChanges();
    expect(track({ toolCallId: "read", kind: "read", status: "completed", locations: [{ path: "read.ts" }] })).toEqual([]);
    expect(track({ toolCallId: "shell", kind: "execute", status: "completed", rawInput: { command: "echo new > new.ts" } })).toEqual([]);
    expect(track({ toolCallId: "title", title: "Created new.ts", status: "completed" })).toEqual([]);
    expect(track({ toolCallId: "failed", kind: "edit", status: "failed", content: [
      { type: "diff", path: "fail.ts", oldText: null, newText: "never written" },
    ] })).toBeUndefined();
    expect(track({ toolCallId: "pending", kind: "edit", locations: [{ path: "pending.ts" }] })).toBeUndefined();
  });

  it("supports late metadata, raw input paths and isolated tool IDs", () => {
    const track = createAcpFileChanges();
    expect(track({ toolCallId: "one", kind: "edit", status: "completed" })).toEqual([]);
    expect(track({ toolCallId: "one", rawInput: { file_path: "late.ts" } })).toEqual([{ path: "late.ts", kind: "modified" }]);
    expect(track({ toolCallId: "two", kind: "edit", status: "completed", rawInput: { path: "other.ts" } }))
      .toEqual([{ path: "other.ts", kind: "modified" }]);
  });
});
