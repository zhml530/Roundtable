/* oxlint-disable anti-slop/no-module-mocking -- Follow the existing WorkspaceNavigation SSR harness; capture real rendered handlers without adding a DOM test dependency. */
import { createElement, isValidElement, type ButtonHTMLAttributes, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot, type Group } from "@/state/store";
import { BotContextMenu, RoomContextMenu } from "./Sidebar";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { AgentChatEmptyState } from "./AgentChatEmptyState";
import { ChannelTree } from "./ChannelTree";

const { buttons, dispatch, writeText } = vi.hoisted(() => {
  const buttons: ButtonHTMLAttributes<HTMLButtonElement>[] = [];
  return { buttons, dispatch: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) };
});

// Capture the handlers produced by the real SSR render without a simulated DOM.
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return {
    ...original,
    jsxDEV: (...args: Parameters<typeof original.jsxDEV>) => {
      const element = original.jsxDEV(...args);
      if (element.type === "button" && isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(element)) buttons.push(element.props);
      return element;
    },
  };
});
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("react/jsx-runtime")>();
  const capture = (factory: typeof original.jsx) => (...args: Parameters<typeof original.jsx>) => {
    const element = factory(...args);
    if (element.type === "button" && isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(element)) buttons.push(element.props);
    return element;
  };
  return { ...original, jsx: capture(original.jsx), jsxs: capture(original.jsxs) };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  createPortal: (children: React.ReactNode) => children,
}));

let state = initialState;
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state, dispatch }),
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { label: "Browser" } } }),
}));

const bot: Bot = {
  id: "agent", threadId: "current", name: "Agent", title: "", description: "",
  notifications: true, color: "blue", unread: false, messages: [],
  modelSelection: { instanceId: "codex", model: "default" },
  tasks: [
    { threadId: "current", title: "Current chat", createdAt: 2 },
    { threadId: "older", title: "Older chat", createdAt: 1 },
  ],
};
const group: Group = {
  id: "channel", threadId: "channel-thread", name: "Engineering",
  memberIds: [], bulletin: "", unread: true, createdAt: 3, messages: [],
};
const onClose = vi.fn();
const onArchive = vi.fn();
const onMoveToSection = vi.fn();

function button(label: string) {
  const found = buttons.find((props) =>
    renderToStaticMarkup(createElement("button", props)).replace(/<[^>]*>/g, "") === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
function click(label: string) {
  const props = button(label);
  expect(props.disabled).not.toBe(true);
  // SAFETY: Menu action handlers take no arguments and never inspect the click event.
  props.onClick?.({} as MouseEvent<HTMLButtonElement>);
}
function renderDirect(threadId = "older", variant: "agent" | "chat" = "agent") {
  return renderToStaticMarkup(createElement(BotContextMenu, {
    menu: { botId: bot.id, x: 100, y: 100 }, threadId, variant, onClose, onArchive, onMoveToSection,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  buttons.length = 0;
  state = { ...initialState, bots: [bot, { ...bot, id: "other" }], groups: [group] };
  vi.stubGlobal("window", { innerHeight: 800, innerWidth: 1200 });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => vi.unstubAllGlobals());

describe("restored conversation menus", () => {
  it("limits Chats direct menus to the five requested actions in order", () => {
    renderDirect("older", "chat");
    expect(buttons.map((props) =>
      renderToStaticMarkup(createElement("button", props)).replace(/<[^>]*>/g, ""),
    )).toEqual(["Rename Chat", "Delete Chat", "Mark message as unread", "Edit profile", "Copy Conversation Id"]);
  });

  it.each(["older", "current"])("targets the clicked %s chat and opens its owning profile", (threadId) => {
    renderDirect(threadId, "chat");
    click("Delete Chat");
    click("Mark message as unread");
    click("Edit profile");
    click("Copy Conversation Id");
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "deleteTask", botId: "agent", threadId },
      { type: "markTaskUnread", botId: "agent", threadId },
      { type: "showAgents", botId: "agent" },
    ]);
    expect(writeText).toHaveBeenCalledWith(threadId);
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it.each(["denied", "unavailable"])("reports %s clipboard failures explicitly", async (failure) => {
    if (failure === "unavailable") vi.stubGlobal("navigator", {});
    else writeText.mockRejectedValueOnce(new Error("Permission denied"));
    renderDirect("older", "chat");
    click("Copy Conversation Id");
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "error", message: expect.stringContaining("Could not copy conversation ID:"),
    });
  });

  it("keeps the busy-chat deletion guard in Chats", () => {
    state = { ...state, bots: [{ ...bot, busy: true }] };
    renderDirect("current", "chat");
    expect(button("Delete Chat").disabled).toBe(true);
    buttons.length = 0;
    renderDirect("older", "chat");
    expect(button("Delete Chat").disabled).toBe(false);
  });

  it("opening an inactive Chats row identifies the read target before switching", () => {
    state = { ...state, bots: [bot] };
    renderToStaticMarkup(createElement(WorkspaceNavigation, { open: true, onClose }));
    const row = buttons.find((props) =>
      props.onContextMenu && renderToStaticMarkup(createElement("button", props)).includes("Older chat"));
    // SAFETY: The row click handler takes no arguments and does not inspect the event.
    row?.onClick?.({} as MouseEvent<HTMLButtonElement>);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "agent", threadId: "older" },
      { type: "switchTask", botId: "agent", threadId: "older" },
    ]);
  });

  it("renders every original action with explicit agent scope and separate chat actions", () => {
    renderDirect();
    for (const label of ["Rename chat", "Delete chat", "Pin agent", "Move agent to context",
      "Mark agent as unread", "Edit Profile", "Duplicate agent", "Copy conversation ID", "Archive agent", "Delete agent"]) {
      button(label);
    }
  });

  it("deletes and copies the clicked inactive chat, not the agent's active chat", () => {
    renderDirect();
    click("Delete chat");
    expect(dispatch).toHaveBeenCalledWith({ type: "deleteTask", botId: "agent", threadId: "older" });
    click("Copy conversation ID");
    expect(writeText).toHaveBeenCalledWith("older");
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteBot" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("preserves agent-level action handlers", () => {
    renderDirect();
    click("Pin agent");
    click("Move agent to context");
    click("Mark agent as unread");
    click("Edit Profile");
    click("Duplicate agent");
    click("Archive agent");
    click("Delete agent");
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "updateBot", botId: "agent", patch: { pinned: true } },
      { type: "markUnread", botId: "agent" },
      { type: "select", id: "agent" },
      { type: "showAgents", botId: "agent" },
      { type: "duplicateBot", botId: "agent" },
      { type: "deleteBot", botId: "agent" },
    ]);
    expect(onArchive).toHaveBeenCalledWith(bot);
    expect(onMoveToSection).toHaveBeenCalledWith("agent");
  });

  it("blocks deletion of the busy active chat but allows deletion of an inactive chat", () => {
    state = { ...state, bots: [{ ...bot, busy: true }] };
    renderDirect("current");
    expect(button("Delete chat").disabled).toBe(true);
    buttons.length = 0;
    renderDirect("older");
    expect(button("Delete chat").disabled).toBe(false);
  });

  it("cannot archive the last visible agent and supports unpinning", () => {
    state = { ...state, bots: [{ ...bot, pinned: true }, { ...bot, id: "hidden", hidden: true }] };
    renderDirect();
    expect(button("Archive agent").disabled).toBe(true);
    click("Unpin agent");
    expect(dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "agent", patch: { pinned: false } });
  });

  it("does not render actions for a deleted chat", () => {
    expect(renderDirect("deleted")).toBe("");
  });

  it("restores channel rename, context, copy and delete actions", () => {
    renderToStaticMarkup(createElement(RoomContextMenu, {
      menu: { groupId: group.id, x: 100, y: 100 }, onClose, onMoveToSection,
    }));
    button("Rename Channel");
    click("Move to context");
    click("Copy conversation ID");
    click("Delete Channel");
    expect(onMoveToSection).toHaveBeenCalledWith("channel");
    expect(writeText).toHaveBeenCalledWith("channel-thread");
    expect(dispatch).toHaveBeenCalledWith({ type: "deleteGroup", groupId: "channel" });
  });

  it("creates a topic from the channel menu using the same callback as the inline plus", () => {
    const onNewTopic = vi.fn();
    renderToStaticMarkup(createElement(RoomContextMenu, {
      menu: { groupId: group.id, x: 100, y: 100 }, onClose, onMoveToSection, onNewTopic,
    }));
    click("New Topic");
    expect(onNewTopic).toHaveBeenCalledWith(group.id);
    buttons.length = 0;
    const topic = { ...group, id: "release", channelId: group.id, topicName: "Release", threadId: "release-thread" };
    const onOpen = vi.fn();
    const markup = renderToStaticMarkup(createElement(ChannelTree, {
      groups: [group, topic], expanded: {}, selectedId: topic.id,
      onToggle: vi.fn(), onOpen, onNewTopic, bindings: () => ({ onContextMenu: vi.fn(), onKeyDown: vi.fn() }),
    }));
    expect(markup).toContain("General");
    expect(markup).toContain("Release");
    const plus = buttons.find((props) => props["aria-label"] === "New Topic in Engineering");
    expect(plus?.className).toContain("group-focus-within:opacity-100");
    plus?.onClick?.({} as MouseEvent<HTMLButtonElement>);
    expect(onNewTopic).toHaveBeenCalledTimes(2);
    click("Release");
    expect(onOpen).toHaveBeenCalledWith(topic);
  });

  it("does not offer topics for bot-to-bot DMs", () => {
    state = { ...state, groups: [{ ...group, dm: true }] };
    const markup = renderToStaticMarkup(createElement(RoomContextMenu, {
      menu: { groupId: group.id, x: 100, y: 100 }, onClose, onMoveToSection, onNewTopic: vi.fn(),
    }));
    expect(markup).not.toContain("New Topic");
  });

  it("wires pointer and keyboard context menus on the actual Chats rows", () => {
    renderToStaticMarkup(createElement(WorkspaceNavigation, { open: true, onClose }));
    const rows = buttons.filter((props) => props.onContextMenu);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.onKeyDown).toBeTypeOf("function");
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps pinned agents' chats first and exposes archived agents for restoration", () => {
    state = { ...state, bots: [
      { ...bot, pinned: true },
      { ...bot, id: "hidden", hidden: true, name: "Hidden agent" },
    ] };
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigation, { open: true, onClose }));
    expect(markup.indexOf("Current chat")).toBeLessThan(markup.indexOf("# Engineering"));
    expect(markup).not.toContain("Hidden agent");
    button("Archived agents (1)");
  });

  it("keeps chatless agents available without rendering phantom conversation rows", () => {
    state = { ...state, bots: [{ ...bot, threadId: "", tasks: [] }], groups: [] };
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigation, { open: true, onClose }));
    expect(markup).toContain("No matching chats");
    expect(buttons.filter((props) => props.onContextMenu)).toHaveLength(0);
    expect(markup).toContain('aria-label="New Chat"');
  });

  it("offers a new chat in the agent's empty state without mounting a composer", () => {
    const onNewChat = vi.fn();
    const markup = renderToStaticMarkup(createElement(AgentChatEmptyState, { name: "Agent", onNewChat }));
    expect(markup).toContain("No chats with Agent");
    expect(markup).not.toContain("textarea");
    click("New chat");
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
