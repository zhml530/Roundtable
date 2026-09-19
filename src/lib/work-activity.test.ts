import { describe, expect, it } from "vitest";
import { mergeWorkActivity } from "./work-activity";

describe("work activity merge", () => {
  it("keeps unprojected tools and reasoning in live event order around transcript anchors", () => {
    const merged = mergeWorkActivity([
      { kind: "message", message: { id: "note", role: "bot", kind: "text", at: 1, text: "Progress" } },
      { kind: "command-run", turnId: "turn", messages: [
        { id: "tool", role: "bot", kind: "activity", at: 1, tool: { name: "Read", itemId: "read", ok: true } },
      ] },
    ], [
      { kind: "reasoning", text: "Planning", at: 1 },
      { kind: "tool", itemId: "read", title: "Read", status: "completed", at: 1 },
      { kind: "tool", itemId: "pending", title: "Test", status: "running", at: 1 },
    ]);
    expect(merged.map((segment) => segment.kind === "persisted" ? segment.message.id : segment.kind)).toEqual([
      "note", "reasoning", "tool", "tool",
    ]);
    expect(merged.at(-1)).toMatchObject({ kind: "tool", itemId: "pending" });
  });

  it("retains approvals and persisted status when live completion is stale", () => {
    const merged = mergeWorkActivity([
      { kind: "command-run", turnId: "turn", messages: [
        { id: "approval", role: "bot", kind: "options", at: 2, card: { title: "Approve", subtitle: "Read file", options: [], tool: "Read", requestId: "r", answered: "allow" } },
        { id: "tool", role: "bot", kind: "activity", at: 2, tool: { name: "Read", itemId: "read", ok: false } },
      ] },
    ], [
      { kind: "tool", itemId: "read", title: "Read", status: "running", at: 2 },
    ]);
    expect(merged).toMatchObject([
      { kind: "persisted", message: { id: "approval" } },
      { kind: "persisted", message: { id: "tool", tool: { ok: false } } },
    ]);
  });
});
