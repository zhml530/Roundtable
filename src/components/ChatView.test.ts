/* oxlint-disable anti-slop/no-module-mocking -- Isolate transcript rendering from store transport and unrelated composer/call UI. */
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot, type Message } from "@/state/store";
import { ChatView } from "./ChatView";

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: initialState, dispatch: vi.fn(), loadEarlierMessages: vi.fn() }),
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

function renderRun(tools: NonNullable<Message["tool"]>[]) {
  const bot: Bot = {
    id: "agent", threadId: "thread", name: "Agent", title: "", description: "",
    notifications: true, color: "blue", unread: false,
    modelSelection: { instanceId: "test", model: "default" },
    messages: tools.map((tool, index) => ({
      id: `tool-${index}`, role: "bot", kind: "activity", at: 1, turnId: "turn", tool,
    })),
  };
  const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
  const start = markup.lastIndexOf('<div class="flex justify-start">', markup.indexOf("Run command"));
  const end = markup.indexOf("</button>", start) + "</button>".length;
  return markup.slice(start, end);
}

describe("ChatView command run summary", () => {
  beforeEach(() => vi.stubGlobal("window", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("renders a transparent unboxed disclosure without a completed count", () => {
    const summary = renderRun([{ name: "Read file", ok: true }, { name: "Run tests", ok: true }]);
    expect(summary).toContain("Run command");
    expect(summary).toContain("2 actions");
    expect(summary).toContain('aria-expanded="false"');
    expect(summary).not.toMatch(/\b\d+ completed\b/);
    expect(summary).not.toMatch(/\b(?:rounded|border|bg)-/);
    expect(summary).not.toContain("hover:bg-");
  });

  it("keeps failed calls in the action count but shows only in-progress status", () => {
    const summary = renderRun([
      { name: "Read file", ok: true },
      { name: "Run tests", ok: false },
      { name: "Build" },
    ]);
    expect(summary).toContain("3 actions");
    expect(summary).not.toContain("1 failed");
    expect(summary).toContain("1 in progress");
    expect(summary).not.toContain("1 completed");
  });
});
