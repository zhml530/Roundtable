import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "copilot", model: "test" });

describe("Channel topics", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("preserves General and persists additional topics without creating hidden channels", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Engineering", [bot.id]);
    store.appendMessage(channel.threadId, { role: "user", kind: "text", text: "Existing history" });
    const topic = store.createTopic(channel.id, " Release ");
    expect(store.groups).toHaveLength(1);
    expect(store.conversation(channel.id)).toMatchObject({ channelId: channel.id, topicName: "General", threadId: channel.threadId });
    expect(store.conversation(topic.id)).toMatchObject({ channelId: channel.id, topicName: "Release" });
    expect(topic.threadId).not.toBe(channel.threadId);
    const restored = new Store(selection);
    expect(restored.conversations(channel.id).map((item) => item.topicName)).toEqual(["General", "Release"]);
    expect(restored.messagesFor(channel.threadId)[0]?.text).toBe("Existing history");
    expect(restored.messagesFor(topic.threadId)).toEqual([]);
  });

  it("isolates same-agent sessions, approval projections, read state and pins across topics", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const direct = bot.threadId;
    const channel = store.createGroup("Engineering", [bot.id]);
    const topic = store.createTopic(channel.id, "Release");
    const generalSession = store.ensureChannelSession(channel.id, bot.id)!;
    const releaseSession = store.ensureChannelSession(topic.id, bot.id, generalSession.threadId)!;
    expect(releaseSession.threadId).not.toBe(generalSession.threadId);
    expect(bot.threadId).toBe(direct);
    store.setResumeCursor(bot.id, "copilot", "release-native", releaseSession.threadId);
    const card = { title: "Approval", subtitle: "Read", options: ["Allow"], requestId: "shared-request" };
    const general = store.appendMessage(generalSession.threadId, { role: "bot", kind: "options", card });
    const release = store.appendMessage(releaseSession.threadId, { role: "bot", kind: "options", card });
    store.patchMessage(releaseSession.threadId, release.id, { card: { ...card, answered: "allow" } });
    expect(store.messagesFor(channel.threadId)[0]?.source?.messageId).toBe(general.id);
    expect(store.messagesFor(channel.threadId)[0]?.card?.answered).toBeUndefined();
    expect(store.messagesFor(topic.threadId)[0]?.card?.answered).toBe("allow");
    store.patchConversation(topic.id, { unread: true, pinnedMessageId: "release-pin" });
    expect(store.conversation(channel.id)?.pinnedMessageId).toBeUndefined();
    expect(store.conversation(channel.id)?.unread).toBe(false);
    const restored = new Store(selection);
    expect(restored.ensureChannelSession(topic.id, bot.id)?.resumeCursors.copilot).toBe("release-native");
    expect(restored.ensureChannelSession(channel.id, bot.id)?.resumeCursors.copilot).toBeUndefined();
    expect(restored.messagesFor(channel.threadId)[0]?.card?.dismissed).toBe(true);
    expect(restored.conversation(topic.id)?.pinnedMessageId).toBe("release-pin");
  });

  it("inherits live channel settings and detaches removed agents from every topic", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Engineering", [bot.id]);
    const topic = store.createTopic(channel.id, "Release");
    store.patchGroup(channel.id, { bulletin: "Shared rules", cwd: DATA_DIR, section: "Work" });
    expect(store.conversation(topic.id)).toMatchObject({ bulletin: "Shared rules", cwd: DATA_DIR, section: "Work" });
    const session = store.ensureChannelSession(topic.id, bot.id)!;
    expect(session.cwd).toBe(DATA_DIR);
    const later = store.createTopic(channel.id, "Later");
    expect(store.conversation(later.id)?.pinnedCwd).toBe(DATA_DIR);
    store.patchGroup(channel.id, { memberIds: [] });
    expect(store.ensureChannelSession(topic.id, bot.id)).toBeNull();
    store.appendMessage(session.threadId, { role: "bot", kind: "text", text: "Detached" });
    expect(store.messagesFor(topic.threadId)).toEqual([]);
    store.deleteGroup(channel.id);
    expect(store.conversation(topic.id)).toBeUndefined();
    expect(new Store(selection).conversations()).toEqual([]);
  });

  it("persists topic-only renames and deletions without changing the parent or siblings", () => {
    const store = new Store(selection);
    const channel = store.createGroup("Engineering", [store.createBot().id]);
    const topic = store.createTopic(channel.id, "Release");
    const sibling = store.createTopic(channel.id, "Planning");
    store.appendMessage(channel.threadId, { role: "user", kind: "text", text: "General history" });
    store.appendMessage(topic.threadId, { role: "user", kind: "text", text: "Release history" });
    store.appendMessage(sibling.threadId, { role: "user", kind: "text", text: "Planning history" });
    expect(store.patchConversation(topic.id, { topicName: " Launch " })).toMatchObject({
      name: "Engineering", topicName: "Launch",
    });
    expect(new Store(selection).conversations(channel.id).map((group) => group.topicName)).toEqual(["General", "Launch", "Planning"]);
    const events: string[] = [];
    store.onChange((event) => {
      if (event.type === "group.deleted") events.push(event.groupId);
    });
    expect(store.deleteConversation(topic.id)).toBe(true);
    expect(events).toEqual([topic.id]);
    expect(store.deleteConversation(topic.id)).toBe(false);
    const restored = new Store(selection);
    expect(restored.conversations(channel.id).map((group) => group.topicName)).toEqual(["General", "Planning"]);
    expect(restored.group(channel.id)?.name).toBe("Engineering");
    expect(restored.messagesFor(channel.threadId)[0]?.text).toBe("General history");
    expect(restored.messagesFor(sibling.threadId)[0]?.text).toBe("Planning history");
    expect(restored.messagesFor(topic.threadId)).toEqual([]);
  });

  it("rejects invalid names, nonexistent parents and DM topics", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Engineering", [bot.id]);
    const dm = store.createGroup("DM", [bot.id], true);
    expect(() => store.createTopic(channel.id, " ")).toThrow(/name/i);
    expect(() => store.createTopic(channel.id, "x".repeat(101))).toThrow(/100/);
    expect(() => store.createTopic("missing", "Release")).toThrow(/channel/i);
    expect(() => store.createTopic(dm.id, "Release")).toThrow(/direct-message/i);
    expect(store.conversation(dm.id)?.topicName).toBeUndefined();
  });
});
