/* oxlint-disable anti-slop/no-module-mocking -- Isolate transcript rendering from store transport and unrelated composer/call UI. */
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot, type Message } from "@/state/store";
import { ChatView } from "./ChatView";

const streamMock = vi.hoisted(() => ({
  current: { streaming: {}, reasoning: {}, activeTurns: {}, startedAt: {}, activity: {} },
}));
interface MockFocusMessage { threadId: string; messageId: string; nonce: number; consumed: boolean }
const focusMock = vi.hoisted<{ current: MockFocusMessage | null }>(() => ({ current: null }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { ...initialState, focusMessage: focusMock.current }, dispatch: vi.fn(), loadEarlierMessages: vi.fn() }),
  useStreaming: () => streamMock.current,
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { label: "Browser" } } }),
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./CallView", () => ({ CallOverlay: () => null }));
vi.mock("./MessageViewport", () => ({
  MessageViewport: ({ items, renderItem, footer }: {
    items: Array<{ key: string }>;
    renderItem: (item: { key: string }) => ReactNode;
    footer?: ReactNode;
  }) => createElement(
    Fragment,
    null,
    ...items.map((item) => createElement("div", { key: item.key }, renderItem(item))),
    footer,
  ),
}));

function renderMessages(messages: Message[], patch: Partial<Bot> = {}) {
  const bot: Bot = {
    id: "agent", threadId: "thread", name: "Agent", title: "", description: "",
    notifications: true, color: "blue", unread: false,
    modelSelection: { instanceId: "test", model: "default" },
    messages,
    ...patch,
  };
  return renderToStaticMarkup(createElement(ChatView, { bot }));
}

function renderRun(tools: NonNullable<Message["tool"]>[]) {
  const markup = renderMessages(tools.map((tool, index) => ({
    id: `tool-${index}`, role: "bot", kind: "activity", at: 1, turnId: "turn", tool,
  })));
  const start = markup.lastIndexOf('<div class="flex justify-start">', markup.indexOf("Work activity"));
  const end = markup.indexOf("</button>", start) + "</button>".length;
  return markup.slice(start, end);
}

describe("ChatView command run summary", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    streamMock.current = { streaming: {}, reasoning: {}, activeTurns: {}, startedAt: {}, activity: {} };
    focusMock.current = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders a transparent unboxed disclosure without a completed count", () => {
    const summary = renderRun([{ name: "Read file", ok: true }, { name: "Run tests", ok: true }]);
    expect(summary).toContain("Work activity");
    expect(summary).toContain("2 actions");
    expect(summary).toContain('aria-expanded="false"');
    expect(summary).not.toMatch(/\b\d+ completed\b/);
    expect(summary).not.toMatch(/\b(?:rounded|border|bg)-/);
    expect(summary).not.toContain("hover:bg-");
  });

  it("keeps failed and in-progress calls in the action count without noisy settled status", () => {
    const summary = renderRun([
      { name: "Read file", ok: true },
      { name: "Run tests", ok: false },
      { name: "Build" },
    ]);
    expect(summary).toContain("3 actions");
    expect(summary).not.toContain("1 failed");
    expect(summary).not.toContain("1 in progress");
    expect(summary).not.toContain("1 completed");
  });

  it("renders interleaved tool slices from one provider turn as one work activity", () => {
    const markup = renderMessages([
      { id: "tool-1", role: "bot", kind: "activity", at: 1, turnId: "turn", tool: { name: "Read file", ok: true } },
      { id: "progress", role: "bot", kind: "text", at: 2, turnId: "turn", text: "Checking another path." },
      { id: "tool-2", role: "bot", kind: "activity", at: 3, turnId: "turn", tool: { name: "Run tests", ok: true } },
      { id: "answer", role: "bot", kind: "text", at: 4, turnId: "turn", text: "Fixed it." },
    ]);

    expect(markup.match(/Work activity/g)).toHaveLength(1);
    expect(markup).toContain("2 actions");
    expect(markup).toContain("Fixed it.");
    expect(markup).not.toContain("Checking another path.");
  });

  it("opens a collapsed activity when focus targets a contained progress note", () => {
    focusMock.current = { threadId: "thread", messageId: "progress", nonce: 1, consumed: false };
    const markup = renderMessages([
      { id: "tool-1", role: "bot", kind: "activity", at: 1, turnId: "turn", tool: { name: "Read file", ok: true } },
      { id: "progress", role: "bot", kind: "text", at: 2, turnId: "turn", text: "Checking another path." },
      { id: "tool-2", role: "bot", kind: "activity", at: 3, turnId: "turn", tool: { name: "Run tests", ok: true } },
      { id: "answer", role: "bot", kind: "text", at: 4, turnId: "turn", text: "Fixed it." },
    ]);

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-mid="progress"');
    expect(markup).toContain("Checking another path.");
  });

  it("keeps live thinking and tool phases in provider event order", () => {
    streamMock.current = {
      streaming: {},
      reasoning: { thread: "Inspecting files.Checking results." },
      activeTurns: { thread: "turn" },
      startedAt: { thread: Date.now() - 5_000 },
      activity: {
        thread: [
          { kind: "reasoning", text: "Inspecting files.", at: 100 },
          { kind: "tool", itemId: "one", title: "Read file", status: "completed", at: 200 },
          { kind: "reasoning", text: "Checking results.", at: 400 },
          { kind: "tool", itemId: "two", title: "Run tests", status: "running", at: 500 },
        ],
      },
    };
    const markup = renderMessages([
      { id: "tool-1", role: "bot", kind: "activity", at: 200, turnId: "turn", tool: { name: "Read file", ok: true, itemId: "one" } },
      { id: "progress", role: "bot", kind: "text", at: 300, turnId: "turn", text: "Found the configuration." },
      { id: "tool-2", role: "bot", kind: "activity", at: 500, turnId: "turn", tool: { name: "Run tests", itemId: "two" } },
    ], { busy: true });

    const detail = markup.slice(markup.indexOf("ml-5 border-l"));
    const phases = ["Inspecting files.", "Read file", "Found the configuration.", "Checking results.", "Run tests"];
    const positions = phases.map((phase) => detail.indexOf(phase));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(markup.match(/Working for /g)).toHaveLength(1);
  });

  it("retains hydrated tools and uses transcript order for equal timestamps", () => {
    streamMock.current = {
      streaming: {}, reasoning: {}, activeTurns: { thread: "turn" },
      startedAt: { thread: Date.now() - 5_000 },
      activity: { thread: [
        { kind: "tool", itemId: "new", title: "Read file", status: "running", at: 300 },
      ] },
    };
    const markup = renderMessages([
      // Identical titles must not cause the hydrated call to be deduplicated.
      { id: "old-tool", role: "bot", kind: "activity", at: 100, turnId: "turn", tool: { name: "Read file", ok: true, itemId: "old" } },
      { id: "legacy-tool", role: "bot", kind: "activity", at: 200, turnId: "turn", tool: { name: "Legacy call", ok: true } },
      { id: "progress", role: "bot", kind: "text", at: 300, turnId: "turn", text: "Checking the next file." },
      { id: "new-tool", role: "bot", kind: "activity", at: 300, turnId: "turn", tool: { name: "Read file", itemId: "new" } },
    ], { busy: true });
    const detail = markup.slice(markup.indexOf("ml-5 border-l"));
    const positions = ["old-tool", "legacy-tool", "progress", "new-tool"].map((id) => detail.indexOf(`data-mid="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(detail.match(/Read file/g)).toHaveLength(2);
    expect(markup).toContain("3 actions");
  });
});

describe("ChatView conversation header", () => {
  it("shows the active conversation title above the agent name", () => {
    const bot: Bot = {
      id: "agent", threadId: "current", name: "Github Copilot", title: "", description: "",
      notifications: true, color: "blue", unread: false,
      modelSelection: { instanceId: "test", model: "default" },
      tasks: [
        { threadId: "current", title: "Top N Chats on Startup", createdAt: 2 },
        { threadId: "older", title: "Older chat", createdAt: 1 },
      ],
      messages: [],
    };

    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const conversationTitle = markup.indexOf(">Top N Chats on Startup<");
    const agentName = markup.indexOf(">Github Copilot<");

    expect(conversationTitle).toBeGreaterThan(-1);
    expect(agentName).toBeGreaterThan(conversationTitle);
    expect(markup).not.toContain("Older chat");
  });
});
