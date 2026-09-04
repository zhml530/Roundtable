import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "copilot", model: "test" });
describe("Channel member sessions", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("persists isolated sessions and keeps direct chats unchanged", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const direct = bot.threadId;
    const a = store.createGroup("A", [bot.id]);
    const b = store.createGroup("B", [bot.id]);
    const first = store.ensureChannelSession(a.id, bot.id)!;
    const second = store.ensureChannelSession(b.id, bot.id)!;
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.threadId).not.toBe(direct);
    expect(bot.threadId).toBe(direct);
    store.setResumeCursor(bot.id, "copilot", "native-session-a", first.threadId);
    const restored = new Store(selection);
    expect(restored.ensureChannelSession(a.id, bot.id)?.resumeCursors.copilot).toBe("native-session-a");
    expect(restored.ensureChannelSession(b.id, bot.id)?.resumeCursors.copilot).toBeUndefined();
  });

  it("mirrors interleaved replies and patches approvals by source session", () => {
    const store = new Store(selection);
    const researcher = store.createBot({ name: "Researcher" });
    const critic = store.createBot({ name: "Critic" });
    const channel = store.createGroup("Project", [researcher.id, critic.id]);
    const a = store.ensureChannelSession(channel.id, researcher.id)!;
    const b = store.ensureChannelSession(channel.id, critic.id)!;
    const card = { title: "Approval", subtitle: "Fetch a paper", tool: "fetch", options: ["Allow", "Deny"], requestId: "same-id-in-different-providers" };
    store.appendMessage(a.threadId, { role: "user", kind: "text", text: "Internal assignment" });
    const first = store.appendMessage(a.threadId, { role: "bot", kind: "options", card });
    const second = store.appendMessage(b.threadId, { role: "bot", kind: "options", card });
    store.appendMessage(b.threadId, { role: "bot", kind: "text", text: "Critic findings" });
    store.appendMessage(a.threadId, { role: "bot", kind: "text", text: "Research findings" });
    store.patchMessage(b.threadId, second.id, { card: { ...card, answered: "allow" } });
    const messages = store.messagesFor(channel.threadId);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ from: { botId: researcher.id }, source: { threadId: a.threadId, messageId: first.id } });
    expect(messages[0]!.card?.answered).toBeUndefined();
    expect(messages[1]!.card?.answered).toBe("allow");
    expect(messages[2]).toMatchObject({ from: { botId: critic.id }, text: "Critic findings" });
    expect(messages[3]).toMatchObject({ from: { botId: researcher.id }, text: "Research findings" });
    const restored = new Store(selection).messagesFor(channel.threadId);
    expect(restored[0]!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(restored[1]!.card?.answered).toBe("allow");
    expect(restored[2]!.text).toBe("Critic findings");
  });

  it("adopts a legacy task once and stops projecting after removal", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const legacy = store.createTask(bot.id, "Old Coordinator task", false)!;
    const a = store.createGroup("A", [bot.id]);
    const b = store.createGroup("B", [bot.id]);
    expect(store.ensureChannelSession(a.id, bot.id, legacy.threadId)?.threadId).toBe(legacy.threadId);
    expect(store.ensureChannelSession(b.id, bot.id, legacy.threadId)?.threadId).not.toBe(legacy.threadId);
    store.patchGroup(a.id, { memberIds: [] });
    store.appendMessage(legacy.threadId, { role: "bot", kind: "text", text: "After removal" });
    expect(store.messagesFor(a.threadId)).toHaveLength(0);
    expect(store.ensureChannelSession(a.id, bot.id)).toBeNull();
  });
});
