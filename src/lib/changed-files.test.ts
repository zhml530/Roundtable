import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { changedFileUrl, changedFilesFromMessages, type ChangedFile } from "./changed-files";

const activity = (id: string, changedFiles: ChangedFile[], ok: boolean | undefined = true): Message => ({
  id, at: Number(id), role: "bot", kind: "activity",
  tool: { name: "apply_patch", ok }, changedFiles,
});

describe("changed file metadata", () => {
  it.each([
    ["D:\\work\\a #1%.tsx", "file:///D:/work/a%20%231%25.tsx"],
    ["/work/a b.ts", "file:///work/a%20b.ts"],
    ["\\\\server\\share\\a.ts", "file://server/share/a.ts"],
    ["javascript:alert(1)", undefined],
    ["relative.ts", undefined],
  ])("links absolute file path %s without treating it as a web URL", (path, expected) => {
    expect(changedFileUrl(path)).toBe(expected);
  });

  it("resolves relative historical paths against the working directory", () => {
    expect(changedFileUrl("src\\a.ts", "D:\\work")).toBe("file:///D:/work/src/a.ts");
  });

  it("lists all successful file types, including removed paths", () => {
    const files: ChangedFile[] = [
      { kind: "created", path: "src\\New.tsx" },
      { kind: "modified", path: "package.json" },
      { kind: "modified", path: "pnpm-lock.yaml" },
      { kind: "deleted", path: "src\\Old.ts" },
    ];
    expect(changedFilesFromMessages([activity("1", files)])).toEqual(files);
  });

  it("does not infer changes from titles, artifacts, or unfinished and failed edits", () => {
    expect(changedFilesFromMessages([
      { ...activity("1", []), tool: { name: "Created src\\Guess.ts", ok: true } },
      { ...activity("2", [{ kind: "modified", path: "pending.ts" }]), tool: { name: "edit" } },
      activity("3", [{ kind: "modified", path: "failed.ts" }], false),
      { id: "4", at: 4, role: "bot", kind: "text", artifacts: [{ path: "doc.md", label: "doc.md", threadId: "t" }] },
    ])).toEqual([]);
  });

  it("deduplicates repeated edits and reflects the final reported operation", () => {
    expect(changedFilesFromMessages([
      activity("1", [{ kind: "created", path: "new.ts" }, { kind: "deleted", path: "old.ts" }]),
      activity("2", [{ kind: "modified", path: "new.ts" }, { kind: "created", path: "old.ts" }]),
    ])).toEqual([{ kind: "created", path: "new.ts" }, { kind: "created", path: "old.ts" }]);
  });
});
