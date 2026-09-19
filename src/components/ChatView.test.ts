// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- Isolate transcript rendering from store transport and unrelated composer/call UI. */
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
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

function chatElement(messages: Message[], patch: Partial<Bot> = {}) {
  const bot: Bot = {
    id: "agent", threadId: "thread", name: "Agent", title: "", description: "",
    notifications: true, color: "blue", unread: false,
    modelSelection: { instanceId: "test", model: "default" },
    messages,
    ...patch,
  };
  return createElement(ChatView, { bot });
}

function renderMessages(messages: Message[], patch: Partial<Bot> = {}) {
  return renderToStaticMarkup(chatElement(messages, patch));
}

function renderRun(tools: NonNullable<Message["tool"]>[]) {
  const markup = renderMessages(tools.map((tool, index) => ({
    id: `tool-${index}`, role: "bot", kind: "activity", at: 1, turnId: "turn", tool,
  })));
  const start = markup.lastIndexOf('<div class="flex justify-start">', markup.indexOf("Worked"));
  const end = markup.indexOf("</button>", start) + "</button>".length;
  return markup.slice(start, end);
}

describe("ChatView command run summary", () => {
  let root: Root | undefined;
  async function mountMessages(messages: Message[], patch: Partial<Bot> = {}) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(() => root!.render(chatElement(messages, patch)));
  }
  function disclosure() {
    const button = document.querySelector<HTMLButtonElement>("button[aria-controls]");
    expect(button).not.toBeNull();
    return button!;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    streamMock.current = { streaming: {}, reasoning: {}, activeTurns: {}, startedAt: {}, activity: {} };
    focusMock.current = null;
  });
  afterEach(async () => {
    if (root) await act(() => root!.unmount());
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("renders a transparent unboxed disclosure without a completed count", () => {
    const summary = renderRun([{ name: "Read file", ok: true }, { name: "Run tests", ok: true }]);
    expect(summary).toContain("Worked for 0m 0s");
    expect(summary).not.toContain("2 actions");
    expect(summary).toContain('aria-expanded="false"');
    expect(summary).not.toMatch(/\b\d+ completed\b/);
    expect(summary).not.toMatch(/\b(?:rounded|border|bg)-/);
    expect(summary).not.toContain("hover:bg-");
  });

  it("keeps the settled summary quiet even when individual calls failed", () => {
    const summary = renderRun([
      { name: "Read file", ok: true },
      { name: "Run tests", ok: false },
      { name: "Build" },
    ]);
    expect(summary).not.toContain("3 actions");
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

    expect(markup.match(/Worked/g)).toHaveLength(1);
    expect(markup).not.toContain("2 actions");
    expect(markup).toContain("Fixed it.");
    expect(markup).not.toContain("Checking another path.");
  });

  it("shows estimated elapsed time and a divider before the answer for older turns", async () => {
    await mountMessages([
      { id: "prompt", role: "user", kind: "text", at: 1_000, text: "Check configuration." },
      { id: "tool", role: "bot", kind: "activity", at: 11_000, turnId: "turn", tool: { name: "Read", ok: true } },
      { id: "answer", role: "bot", kind: "text", at: 66_000, turnId: "turn", text: "Configuration checked." },
    ]);
    expect(disclosure().textContent).toContain("Worked for 1m 5s");
    const divider = document.querySelector("hr");
    const answer = document.querySelector('[data-mid="answer"]');
    expect(divider).not.toBeNull();
    expect(disclosure().classList.contains("pb-1")).toBe(true);
    expect(disclosure().classList.contains("px-1")).toBe(true);
    expect(divider?.classList.contains("mt-0")).toBe(true);
    expect(divider?.classList.contains("mx-1")).toBe(true);
    expect(disclosure().compareDocumentPosition(divider!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider!.compareDocumentPosition(answer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(() => disclosure().click());
    expect(document.querySelectorAll("hr")).toHaveLength(1);
  });

  it("lists all ACP changed files once below the answer even when work is collapsed", async () => {
    await mountMessages([
      { id: "edit", role: "bot", kind: "activity", at: 1, turnId: "turn",
        tool: { name: "apply_patch", ok: true }, changedFiles: [
          { path: "src\\added.tsx", kind: "created" },
          { path: "src\\changed.ts", kind: "modified" },
          { path: "src\\removed.ts", kind: "deleted" },
          { path: "pnpm-lock.yaml", kind: "modified" },
        ] },
      { id: "again", role: "bot", kind: "activity", at: 2, turnId: "turn",
        tool: { name: "edit", ok: true }, changedFiles: [{ path: "src\\changed.ts", kind: "modified" }] },
      { id: "answer", role: "bot", kind: "text", at: 3, turnId: "turn", text: "Done." },
    ]);
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    const sections = document.querySelectorAll('section[aria-label="Changed file"]');
    expect(sections).toHaveLength(1);
    expect(sections[0].querySelectorAll("li")).toHaveLength(4);
    expect(sections[0].textContent).toContain("Added");
    expect(sections[0].textContent).toContain("Removed");
    expect(document.querySelector('[data-mid="answer"]')!.compareDocumentPosition(sections[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).not.toContain("Deliverables");
  });

  it("hides Changed file for old workspace artifacts, title guesses and failed edits", () => {
    const markup = renderMessages([
      { id: "guess", role: "bot", kind: "activity", at: 1, turnId: "turn", tool: { name: "Created new.ts", ok: true } },
      { id: "failed", role: "bot", kind: "activity", at: 2, turnId: "turn", tool: { name: "edit", ok: false },
        changedFiles: [{ path: "failed.ts", kind: "modified" }] },
      { id: "answer", role: "bot", kind: "text", at: 3, turnId: "turn", text: "Done.",
        artifacts: [{ path: "docs\\plan.md", label: "plan.md", threadId: "thread" }] },
    ]);
    expect(markup).not.toContain('aria-label="Changed file"');
    expect(markup).not.toContain("Deliverables");
    expect(markup).not.toContain("plan.md");
  });

  it("shows successful edits even when a turn ends without a text answer", () => {
    const markup = renderMessages([
      { id: "edit", role: "bot", kind: "activity", at: 1, turnId: "turn", tool: { name: "edit", ok: true },
        changedFiles: [{ path: "saved.ts", kind: "modified" }] },
    ]);
    expect(markup).toContain('aria-label="Changed file"');
    expect(markup).toContain("saved.ts");
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
    focusMock.current = { threadId: "thread", messageId: "progress", nonce: 1, consumed: false };
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
    focusMock.current = { threadId: "thread", messageId: "progress", nonce: 1, consumed: false };
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

  it("keeps a live execution log compact while showing parallel tool status", () => {
    streamMock.current = {
      streaming: {}, reasoning: {}, activeTurns: { thread: "turn" },
      startedAt: { thread: Date.now() - 1_000 }, activity: {},
    };
    const markup = renderMessages([
      { id: "one", role: "bot", kind: "activity", at: 1, turnId: "turn", tool: { name: "Read private file" } },
      { id: "two", role: "bot", kind: "activity", at: 2, turnId: "turn", tool: { name: "Run checks" } },
    ], { busy: true });
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("2 tools running");
    expect(markup).not.toContain("Read private file");
    expect(markup.match(/Working for /g)).toHaveLength(1);
  });

  it("uses the same activity status before a streamed tool gets projected", () => {
    streamMock.current = {
      streaming: {}, reasoning: {}, activeTurns: { thread: "turn" },
      startedAt: { thread: Date.now() - 1_000 },
      activity: { thread: [{ kind: "tool", itemId: "new", title: "Read file", status: "running", at: 1 }] },
    };
    const markup = renderMessages([
      { id: "progress", role: "bot", kind: "text", at: 0, turnId: "turn", text: "Inspecting the file next." },
    ], { busy: true });
    expect(markup).toContain("Running Read file");
    expect(markup.match(/Working for /g)).toHaveLength(1);
  });

  it("shows drafting instead of stale thinking when assistant text streams", () => {
    streamMock.current = {
      streaming: { thread: "Here is the answer" }, reasoning: { thread: "Prior thinking" },
      activeTurns: { thread: "turn" }, startedAt: { thread: Date.now() - 1_000 }, activity: {},
    };
    const markup = renderMessages([], { busy: true });
    expect(markup).toContain("Drafting response…");
    expect(markup).not.toContain("Prior thinking");
    expect(markup).not.toContain("0 actions");
  });

  it("preserves manual expansion across approvals and unrelated focus, then collapses on completion", async () => {
    streamMock.current = {
      streaming: {}, reasoning: {}, activeTurns: { thread: "turn" },
      startedAt: { thread: Date.now() - 1_000 }, activity: {},
    };
    const tool: Message = { id: "tool", role: "bot", kind: "activity", at: 1, turnId: "turn", tool: { name: "Read file" } };
    const approval: Message = {
      id: "approval", role: "bot", kind: "options", at: 2, turnId: "turn",
      card: { title: "Approval needed", subtitle: "Run tests", options: [], tool: "Bash", requestId: "request" },
    };
    await mountMessages([tool], { busy: true });
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("hr")).toBeNull();
    await act(() => disclosure().click());
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");

    await mountMessages([tool, approval], { busy: true });
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-mid="approval"]')).not.toBeNull();
    const answered: Message = { ...approval, card: { ...approval.card!, answered: "allow" } };
    await mountMessages([tool, answered], { busy: true });
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");

    focusMock.current = { threadId: "thread", messageId: "elsewhere", nonce: 1, consumed: false };
    await mountMessages([tool, answered], { busy: true });
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    focusMock.current = null;
    await mountMessages([tool, answered], { busy: true });
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");

    const answer: Message = { id: "answer", role: "bot", kind: "text", at: 3, turnId: "turn", text: "All done.", turnDurationMs: 65_000 };
    await mountMessages([{ ...tool, tool: { name: "Read file", ok: true } }, answered, answer], { busy: false });
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    expect(disclosure().textContent).toContain("Worked for 1m 5s");
    expect(document.body.textContent).toContain("All done.");
    await act(() => disclosure().click());
    expect(document.body.textContent).toContain("Allowed once");
    expect(document.body.textContent).toContain("Read file");
  });

  it("keeps every pending approval visible outside the collapsed details", async () => {
    const messages: Message[] = ["one", "two"].map((id) => ({
      id, role: "bot", kind: "options", at: 1, turnId: "turn",
      card: { title: "Approval needed", subtitle: `Read ${id}`, options: [], tool: "Read", requestId: id },
    }));
    await mountMessages(messages, { busy: true });
    const details = document.getElementById(disclosure().getAttribute("aria-controls")!);
    expect(details?.hidden).toBe(true);
    for (const message of messages) {
      const card = document.querySelector(`[data-mid="${message.id}"]`);
      expect(card?.textContent).toContain(message.card!.subtitle);
      expect(details?.contains(card)).toBe(false);
    }
  });

  it("reveals Markdown progress through focus after the activity has mounted", async () => {
    const messages: Message[] = [
      { id: "progress", role: "bot", kind: "text", at: 1, turnId: "turn", text: "Checking **configuration**." },
      { id: "tool", role: "bot", kind: "activity", at: 2, turnId: "turn", tool: { name: "Read", ok: true } },
    ];
    await mountMessages(messages);
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    focusMock.current = { threadId: "thread", messageId: "progress", nonce: 1, consumed: false };
    await mountMessages(messages);
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-mid="progress"] strong')?.textContent).toBe("configuration");
  });

  it("previews thinking on one line and switches to drafting without closing expanded details", async () => {
    streamMock.current = {
      streaming: {}, reasoning: { thread: "Inspecting configuration." },
      activeTurns: { thread: "turn" }, startedAt: { thread: Date.now() - 65_000 },
      activity: { thread: [{ kind: "reasoning", text: "Inspecting configuration.", at: 1 }] },
    };
    await mountMessages([], { busy: true });
    expect(document.body.textContent).toContain("Working for 1m 5s");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Inspecting configuration.");
    expect(document.querySelector("details")).toBeNull();
    await act(() => disclosure().click());
    const thinking = document.querySelector("details");
    expect(thinking?.open).toBe(false);
    if (thinking) thinking.open = true;
    streamMock.current = { ...streamMock.current, streaming: { thread: "Here is the answer." } };
    await mountMessages([], { busy: true });
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("details")?.open).toBe(true);
    expect(document.body.textContent).toContain("Drafting response");
    expect(document.body.textContent).toContain("Here is the answer.");
  });

  it("shows the latest nonempty thinking line and updates it as reasoning streams", async () => {
    streamMock.current = {
      streaming: {}, reasoning: { thread: "Old phase" },
      activeTurns: { thread: "turn" }, startedAt: { thread: Date.now() },
      activity: { thread: [{ kind: "reasoning", text: "Earlier thought.\n Checking\t the files. \n", at: 1 }] },
    };
    await mountMessages([], { busy: true });
    const status = () => document.querySelector('[role="status"] span');
    expect(status()?.textContent).toBe("Checking the files.");
    expect(status()?.classList.contains("truncate")).toBe(true);
    expect(status()?.getAttribute("title")).toBe("Checking the files.");
    expect(document.body.textContent).not.toContain("Thinking…");
    streamMock.current = {
      ...streamMock.current,
      activity: { thread: [{ kind: "reasoning", text: "Earlier thought.\nChecking the files.\nFound the cause.", at: 1 }] },
    };
    await mountMessages([], { busy: true });
    expect(status()?.textContent).toBe("Found the cause.");
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
  });

  it("uses the reasoning stream preview when ordered activity is unavailable", () => {
    streamMock.current = {
      streaming: {}, reasoning: { thread: "First thought.\r\nInspecting the result." },
      activeTurns: { thread: "turn" }, startedAt: { thread: Date.now() }, activity: {},
    };
    const markup = renderMessages([], { busy: true });
    expect(markup).toContain("Inspecting the result.");
    expect(markup).not.toContain("Thinking…");
    expect(markup).not.toContain("First thought.");
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
