import { describe, expect, it } from "vitest";
import { initialState, reducer, type Bot } from "./store";

const bot: Bot = {
  id: "agent", threadId: "old-chat", name: "Agent", title: "", description: "Retained profile",
  notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "codex", model: "default" },
  tasks: [{ threadId: "old-chat", title: "Old chat", createdAt: 1 }],
  messages: [{ id: "old-message", at: 1, role: "bot", kind: "text", text: "Deleted transcript" }],
  lastMessage: { id: "old-message", at: 1, role: "bot", kind: "text", text: "Deleted transcript" },
  activeLeafId: "old-message",
};

describe("agents without chats", () => {
  it("clears deleted content on the slim bot event before the request completes", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, {
      type: "botPatched",
      bot: { ...bot, threadId: "", tasks: [], messages: undefined },
    });
    expect(next.bots[0]).toMatchObject({
      id: bot.id, description: "Retained profile", threadId: "", tasks: [], messages: [], activeLeafId: null,
    });
    expect(next.bots[0]?.lastMessage).toBeUndefined();
    expect(next.selectedId).toBe(bot.id);
  });

  it("does not create a message-page entry for an absent chat after deletion", () => {
    const next = reducer({ ...initialState, bots: [bot], selectedId: bot.id }, {
      type: "taskSwitched", bot: { ...bot, threadId: "", tasks: [], messages: [] },
    });
    expect(next.bots[0]?.messages).toEqual([]);
    expect(next.bots[0]?.lastMessage).toBeUndefined();
    expect(Object.hasOwn(next.messagePages, "")).toBe(false);
    expect(next.bots).toHaveLength(1);
    expect(next.selectedId).toBe(bot.id);
  });

  it("can select a chatless agent and later display a newly created chat", () => {
    const empty = { ...bot, threadId: "", tasks: [], messages: [] };
    const selected = reducer({ ...initialState, bots: [empty] }, { type: "select", id: bot.id });
    expect(selected.selectedId).toBe(bot.id);
    const chat = { threadId: "new-chat", title: "New chat", createdAt: 2 };
    const next = reducer(selected, {
      type: "taskSwitched", bot: { ...empty, threadId: chat.threadId, tasks: [chat] },
    });
    expect(next.bots[0]?.threadId).toBe("new-chat");
    expect(next.bots[0]?.messages).toEqual([]);
    expect(next.messagePages["new-chat"]?.loaded).toBe(true);
  });
});

describe("per-chat unread state", () => {
  const marked: Bot = {
    ...bot, unread: true,
    tasks: [
      { threadId: "old-chat", title: "Old chat", createdAt: 1, unread: true, unreadSource: "manual" },
      { threadId: "inactive", title: "Inactive chat", createdAt: 2, unread: true, unreadSource: "manual" },
    ],
  };

  it("preserves both manual marks on hydration and unrelated bot announcements", () => {
    const hydrated = reducer(initialState, { type: "hydrate", bots: [marked], groups: [] });
    const next = reducer(hydrated, { type: "botPatched", bot: { ...marked, name: "Renamed agent" } });
    expect(next.bots[0]?.tasks).toEqual(marked.tasks);
    expect(next.bots[0]?.unread).toBe(true);
  });

  it("reading the inactive chat does not clear the active chat", () => {
    const next = reducer({ ...initialState, bots: [marked] }, {
      type: "select", id: marked.id, threadId: "inactive",
    });
    expect(next.bots[0]?.unread).toBe(true);
    expect(next.bots[0]?.tasks?.map((task) => task.unread)).toEqual([true, false]);
    expect(next.bots[0]?.tasks?.[1]?.unreadSource).toBeUndefined();
  });

  it("reading the selected chat again clears only that chat, including legacy selection", () => {
    const next = reducer({ ...initialState, selectedId: marked.id, bots: [marked] }, {
      type: "select", id: marked.id,
    });
    expect(next.bots[0]?.unread).toBe(false);
    expect(next.bots[0]?.tasks?.map((task) => task.unread)).toEqual([false, true]);
  });

  it("keeps legacy markUnread scoped to the active chat", () => {
    const next = reducer({ ...initialState, bots: [bot] }, { type: "markUnread", botId: bot.id });
    expect(next.bots[0]?.unread).toBe(true);
    expect(next.bots[0]?.tasks?.[0]).toMatchObject({ unread: true });
  });

  it("does not optimistically leave a false unread badge when persistence fails", () => {
    const state = { ...initialState, bots: [bot] };
    expect(reducer(state, { type: "markTaskUnread", botId: bot.id, threadId: bot.threadId })).toBe(state);
  });
});
