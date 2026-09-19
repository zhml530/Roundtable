import { describe, expect, it } from "vitest";
import { formatWorkDuration, mergeWorkActivity, workDuration } from "./work-activity";
import type { Message } from "@/state/store";

describe("work duration", () => {
  it.each([
    [-1, "0m 0s"],
    [0, "0m 0s"],
    [999, "0m 0s"],
    [59_999, "0m 59s"],
    [60_000, "1m 0s"],
    [125_000, "2m 5s"],
  ])("formats %i milliseconds as %s", (milliseconds, expected) => {
    expect(formatWorkDuration(milliseconds)).toBe(expected);
  });

  const prompt: Message = { id: "prompt", role: "user", kind: "text", at: 1_000 };
  const tool: Message = { id: "tool", role: "bot", kind: "activity", at: 11_000 };
  const answer: Message = { id: "answer", role: "bot", kind: "text", at: 66_000 };
  it("uses saved duration rather than transcript estimates", () => {
    expect(workDuration([tool, { ...answer, turnDurationMs: 70_000 }], [prompt, tool, answer])).toBe(70_000);
  });
  it("estimates old turns from the adjacent user prompt through the answer", () => {
    expect(workDuration([tool, answer], [prompt, tool, answer])).toBe(65_000);
  });
  it("prefers a recorded start and handles paginated history without a prompt", () => {
    expect(workDuration([{ ...tool, turnStartedAt: 6_000 }, answer], [prompt, tool, answer])).toBe(60_000);
    expect(workDuration([tool, answer], [tool, answer])).toBe(55_000);
  });
  it("does not include a previous bot turn or return negative elapsed time", () => {
    expect(workDuration([tool, answer], [{ ...prompt, role: "bot" }, tool, answer])).toBe(55_000);
    expect(workDuration([tool, { ...answer, at: 0 }], [tool, answer])).toBe(0);
  });
});

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
