import { describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Group } from "@/state/store";
import { createChannelTopic, channelEntries } from "./channel-topics";

const general: Group = {
  id: "channel", channelId: "channel", topicName: "General", threadId: "general-thread",
  name: "Engineering", memberIds: [], bulletin: "", unread: false, createdAt: 1, messages: [],
};
const release: Group = { ...general, id: "release", topicName: "Release", threadId: "release-thread" };

describe("topic navigation", () => {
  it("groups explicit topic conversations under one channel", () => {
    expect(channelEntries([release, general])).toEqual([{ channel: general, topics: [general, release] }]);
  });

  it("keeps DM conversations separate and supports legacy General", () => {
    const legacy = { ...general, channelId: undefined, topicName: undefined };
    const dm = { ...legacy, id: "dm", dm: true };
    expect(channelEntries([legacy, dm])).toEqual([
      { channel: legacy, topics: [legacy] }, { channel: dm, topics: [dm] },
    ]);
  });

  it("selects the newly persisted topic only after creation succeeds", async () => {
    const dispatch = vi.fn();
    const persist = vi.fn(async () => release);
    const result = await createChannelTopic(general.id, " Release ", dispatch, persist);
    expect(persist).toHaveBeenCalledWith("channel", "Release");
    expect(result).toBe(release);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "groupPatched", group: release }, { type: "select", id: "release" },
    ]);
  });

  it("propagates creation errors without closing or selecting a nonexistent topic", async () => {
    const dispatch = vi.fn();
    await expect(createChannelTopic(general.id, "Release", dispatch, async () => {
      throw new Error("Could not save topic");
    })).rejects.toThrow("Could not save topic");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps messages and run updates on the addressed topic", () => {
    const state = { ...initialState, groups: [general, release], selectedId: general.id };
    const message = { id: "message", role: "bot" as const, kind: "text" as const, at: 2, text: "Release only" };
    const updated = reducer(state, { type: "messageAdded", threadId: release.threadId, message });
    expect(updated.groups[0]?.messages).toEqual([]);
    expect(updated.groups[1]?.messages).toEqual([message]);
    const patched = reducer(updated, { type: "groupPatched", group: { id: release.id, unread: true } });
    expect(patched.groups[0]?.unread).toBe(false);
    expect(patched.groups[1]?.unread).toBe(true);
  });

  it("applies inherited settings optimistically to sibling topics but keeps pins local", () => {
    const state = { ...initialState, groups: [general, release] };
    const updated = reducer(state, { type: "patchGroup", groupId: release.id, patch: { bulletin: "Shared instructions" } });
    expect(updated.groups.map((group) => group.bulletin)).toEqual(["Shared instructions", "Shared instructions"]);
    const pinned = reducer(updated, { type: "patchGroup", groupId: release.id, patch: { pinnedMessageId: "release-only" } });
    expect(pinned.groups[0]?.pinnedMessageId).toBeUndefined();
    expect(pinned.groups[1]?.pinnedMessageId).toBe("release-only");
  });
});
