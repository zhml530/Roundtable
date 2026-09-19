import { describe, expect, it } from "vitest";

import { unreadConversationCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible bot and room conversations but ignores archived bots", () => {
    expect(
      unreadConversationCount(
        [{ unread: true }, { unread: false }, { unread: true, hidden: true }],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(2);
  });

  it("counts individual chats without double-counting the active legacy mirror", () => {
    const bot = {
      threadId: "active", unread: true,
      tasks: [{ threadId: "active", unread: true }, { threadId: "inactive", unread: true }],
    };
    expect(unreadConversationCount([bot, { ...bot, hidden: true }], [{ unread: true }])).toBe(3);
    expect(unreadConversationCount([{ threadId: "active", unread: true, tasks: [
      { threadId: "active" }, { threadId: "inactive" },
    ] }], [])).toBe(1);
  });
});
