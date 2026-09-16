import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { channelViewportRows, isCoordinatorMessage } from "./channel-message-viewport";

const message = (patch: Partial<Message> & Pick<Message, "id">): Message => ({
  role: "bot",
  kind: "text",
  text: patch.id,
  at: Date.UTC(2026, 8, 16, 9),
  from: { botId: "agent", name: "Agent", color: "blue" },
  ...patch,
});

describe("channelViewportRows", () => {
  it("keeps sender clusters continuous across independently rendered rows", () => {
    const rows = channelViewportRows([
      message({ id: "a" }),
      message({ id: "b" }),
      message({ id: "c", from: { botId: "other", name: "Other", color: "green" } }),
    ]);

    expect(rows.map((row) => row.showCluster)).toEqual([true, false, true]);
    expect(rows.map((row) => row.showDaySeparator)).toEqual([true, false, false]);
  });

  it("starts a new boundary for a new day and for Coordinator delivery", () => {
    const rows = channelViewportRows([
      message({ id: "agent" }),
      message({ id: "coordinator", author: "coordinator" }),
      message({ id: "tomorrow", at: Date.UTC(2026, 8, 17, 9) }),
    ]);

    expect(rows.map((row) => row.showCluster)).toEqual([true, true, true]);
    expect(rows.map((row) => row.showDaySeparator)).toEqual([true, false, true]);
  });

  it("filters duplicated sourced activity and recognizes legacy Coordinator messages", () => {
    const legacy = message({ id: "legacy", executionReport: "done" });
    const rows = channelViewportRows([
      message({ id: "hidden", kind: "activity", source: { threadId: "member", messageId: "source" } }),
      legacy,
    ]);

    expect(rows.map((row) => row.key)).toEqual(["legacy"]);
    expect(isCoordinatorMessage(legacy)).toBe(true);
  });
});
