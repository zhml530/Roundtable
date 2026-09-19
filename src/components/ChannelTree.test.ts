import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Group } from "@/state/store";
import { ChannelTree } from "./ChannelTree";

const channel: Group = {
  id: "channel",
  threadId: "channel-thread",
  name: "Engineering",
  memberIds: Array.from({ length: 7 }, (_, index) => `agent-${index}`),
  bulletin: "",
  unread: false,
  createdAt: 1,
  messages: [],
};

function renderTopic(topicName: string) {
  const topic: Group = {
    ...channel,
    id: "topic",
    threadId: "topic-thread",
    channelId: channel.id,
    topicName,
    unread: true,
  };
  return renderToStaticMarkup(createElement(ChannelTree, {
    groups: [channel, topic],
    expanded: {},
    selectedId: topic.id,
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    onNewTopic: vi.fn(),
    bindings: () => ({ onContextMenu: vi.fn(), onKeyDown: vi.fn() }),
  }));
}

describe("channel topic presentation", () => {
  it("omits the redundant coordinator and agent-count footer while retaining topics", () => {
    const markup = renderTopic("Release");
    expect(markup).not.toContain("Coordinator");
    expect(markup).not.toContain("7 agents");
    expect(markup).toContain(">Engineering</span>");
    expect(markup).toContain(">General</span>");
    expect(markup).toMatch(/<button\b[^>]*aria-current="page"[^>]*><span[^>]*>Release<\/span>/);
    expect(markup).toContain('aria-label="Unread"');
    expect(markup).toContain('aria-label="New Topic in Engineering"');
  });

  it("preserves a stored topic whose name resembles the removed footer", () => {
    const markup = renderTopic("Coordinator · 7 agents");
    expect(markup).toMatch(/<button\b[^>]*aria-current="page"[^>]*><span[^>]*>Coordinator · 7 agents<\/span>/);
  });
});
