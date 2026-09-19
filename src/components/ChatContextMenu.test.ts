// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- Desktop capabilities are unrelated to the real navigation/store integration under test. */
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type Bot } from "@/state/store";
import type { OrchestrationEvent } from "@/lib/orchestration";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { label: "Browser" } } }),
}));

let root: Root;
let serverBot: Bot;
let latest: ReturnType<typeof useStore>;
let onEvent: (frame: OrchestrationEvent) => void;
let failPatch: boolean;

const request = vi.fn(async ({ path, method, body }: { path: string; method: string; body?: string }) => {
  let status = 200;
  const result = (() => {
    if (path === "/api/bots?messages=0") return { bots: [serverBot], groups: [] };
    if (path.includes("/messages?")) return { messages: [], hasMore: false };
    if (path === "/api/instances") return { instances: [] };
    if (path === "/api/routines") return { routines: [], runs: [] };
    if (path === "/api/webhooks") return { webhooks: [], attempts: [] };
    if (method === "POST" && path === "/api/bots") {
      return { bot: { ...serverBot, id: "copy", name: "New Agent", threadId: "", tasks: [], messages: [] } };
    }
    if (method === "PATCH" && path === "/api/bots/copy") return { bot: JSON.parse(body!) };
    if (method === "DELETE" && path.includes("/tasks/")) {
      const threadId = path.split("/").at(-1)!.split("?")[0];
      serverBot.tasks = serverBot.tasks!.filter((task) => task.threadId !== threadId);
      return { bot: structuredClone(serverBot) };
    }
    if (method === "PATCH" && path.includes("/tasks/")) {
      const task = serverBot.tasks!.find((item) => item.threadId === path.split("/").at(-1))!;
      if (failPatch) {
        status = 500;
        return { error: "Could not save chat" };
      }
      const patch = JSON.parse(body!);
      if ("unread" in patch) {
        task.unread = patch.unread;
        task.unreadSource = patch.unread ? "manual" : undefined;
        if (task.threadId === serverBot.threadId) serverBot.unread = patch.unread;
      } else task.title = patch.title;
      onEvent({ kind: "bot", bot: structuredClone(serverBot) });
      return { task };
    }
    return {};
  })();
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(result)) };
});

function Probe() {
  latest = useStore();
  return null;
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(StoreProvider, { children: createElement(Fragment, null,
      createElement(Probe), createElement(WorkspaceNavigation, { open: true, onClose: vi.fn() }),
    ) }));
  });
  // Hydration starts in an effect; wait only after the initial render commits.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function row(title: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("section button"))
    .find((button) => button.textContent?.includes(title));
  expect(found).toBeDefined();
  return found!;
}

function menuLabels() {
  return Array.from(document.querySelectorAll("[data-bot-menu] button")).map((button) => button.textContent);
}

async function openMenu(title: string) {
  const opener = row(title);
  opener.focus();
  await act(() => opener.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true })));
  return opener;
}

async function clickAction(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-bot-menu] button"))
    .find((candidate) => candidate.textContent === label)!;
  expect(button).toBeDefined();
  await act(() => button.click());
}

async function switchTab(tab: "Chats" | "Tasks" | "Agents") {
  await act(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${tab}"]`)!.click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockClear();
  failPatch = false;
  serverBot = {
    id: "agent", threadId: "current", name: "Agent", title: "", description: "",
    notifications: true, color: "blue", unread: false, messages: [],
    modelSelection: { instanceId: "codex", model: "default" },
    tasks: [
      { threadId: "current", title: "Current chat", createdAt: 2 },
      { threadId: "older", title: "Older chat", createdAt: 1 },
    ],
  };
  vi.stubGlobal("ogb", { orchestration: {
    request,
    onEvent: (listener: typeof onEvent) => { onEvent = listener; return () => {}; },
  } });
  await mount();
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("workspace menus with the live store", () => {
  it.each(["Chats", "Tasks"] as const)("keeps keyboard opening, initial focus and Escape focus restoration in %s", async (tab) => {
    await switchTab(tab);
    const opener = await openMenu("Older chat");
    expect(menuLabels()).toEqual(tab === "Chats"
      ? ["Rename Chat", "Delete Chat", "Mark message as unread", "Edit profile", "Copy Conversation Id"]
      : ["Rename Chat", "Delete Chat", "Edit Profile", "Copy Conversation Id"]);
    expect(document.activeElement?.textContent).toBe("Rename Chat");
    await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it.each(["Chats", "Tasks"] as const)("renames the clicked inactive chat and closes the menu in %s", async (tab) => {
    await switchTab(tab);
    request.mockClear();
    await openMenu("Older chat");
    await clickAction("Rename Chat");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Chat name"]')!;
    expect(document.activeElement).toBe(input);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Revised chat");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(() => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: "/api/bots/agent/tasks/older", method: "PATCH", body: JSON.stringify({ title: "Revised chat" }),
    }));
    expect(serverBot.tasks![1].title).toBe("Revised chat");
    expect(serverBot.tasks![0].title).toBe("Current chat");
    expect(latest.state.bots[0].threadId).toBe("current");
    expect(request.mock.calls.filter(([call]) => call.method !== "GET")).toHaveLength(1);
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it("switches between compact Tasks and unchanged Chats menus without leaving an overlay open", async () => {
    await switchTab("Tasks");
    await openMenu("Older chat");
    expect(menuLabels()).toEqual(["Rename Chat", "Delete Chat", "Edit Profile", "Copy Conversation Id"]);
    await switchTab("Chats");
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
    await openMenu("Older chat");
    expect(menuLabels()).toEqual(["Rename Chat", "Delete Chat", "Mark message as unread", "Edit profile", "Copy Conversation Id"]);
  });

  it("opens the inactive task's owning profile without switching chats or marking either chat read", async () => {
    await act(() => {
      onEvent({ kind: "bot", bot: { ...serverBot, id: "other", name: "Other Agent", threadId: "", tasks: [] } });
    });
    await act(() => latest.dispatch({ type: "select", id: "other" }));
    serverBot.unread = true;
    for (const task of serverBot.tasks!) {
      task.unread = true;
      task.unreadSource = "manual";
    }
    await act(() => onEvent({ kind: "bot", bot: structuredClone(serverBot) }));
    await switchTab("Tasks");
    request.mockClear();
    await openMenu("Older chat");
    expect(latest.state.selectedId).toBe("other");
    await clickAction("Edit Profile");
    expect(latest.state.activeView).toBe("agents");
    expect(latest.state.selectedId).toBe("agent");
    const owner = latest.state.bots.find((bot) => bot.id === "agent")!;
    expect(owner.threadId).toBe("current");
    expect(owner.tasks!.map((task) => task.unread)).toEqual([true, true]);
    expect(serverBot.tasks!.map((task) => task.unread)).toEqual([true, true]);
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it("copies the clicked inactive Tasks conversation without opening or reading it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await switchTab("Tasks");
    request.mockClear();
    await openMenu("Older chat");
    await clickAction("Copy Conversation Id");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("older");
    expect(latest.state.bots[0].threadId).toBe("current");
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it("blocks busy active task deletion but deletes the clicked inactive conversation through the existing API", async () => {
    serverBot.busy = true;
    await act(() => onEvent({ kind: "bot", bot: structuredClone(serverBot) }));
    await switchTab("Tasks");
    request.mockClear();
    await openMenu("Current chat");
    const deletion = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-bot-menu] button"))
      .find((button) => button.textContent === "Delete Chat")!;
    expect(deletion.disabled).toBe(true);
    await act(() => deletion.click());
    expect(request).not.toHaveBeenCalled();
    await openMenu("Older chat");
    await clickAction("Delete Chat");
    expect(request.mock.calls.filter(([call]) => call.method !== "GET").map(([call]) => call)).toEqual([
      expect.objectContaining({ path: "/api/bots/agent/tasks/older?messages=10", method: "DELETE" }),
    ]);
    expect(latest.state.bots[0].tasks!.map((task) => task.threadId)).toEqual(["current"]);
    expect(latest.state.bots[0].threadId).toBe("current");
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it("duplicates the clicked agent using the existing create-and-copy-profile path", async () => {
    await switchTab("Agents");
    request.mockClear();
    await openMenu("Agent");
    expect(menuLabels()).toEqual(["Duplicate", "Delete"]);
    expect(document.activeElement?.textContent).toBe("Duplicate");
    await clickAction("Duplicate");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/bots", method: "POST" }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: "/api/bots/copy", method: "PATCH",
      body: JSON.stringify({
        name: "Agent copy", title: "", description: "", notifications: true, modelSelection: serverBot.modelSelection,
      }),
    }));
    expect(latest.state.bots.find((bot) => bot.id === "copy")?.name).toBe("Agent copy");
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it("deletes a chatless agent using the existing agent deletion path", async () => {
    serverBot.threadId = "";
    serverBot.tasks = [];
    await act(() => onEvent({ kind: "bot", bot: structuredClone(serverBot) }));
    await switchTab("Agents");
    request.mockClear();
    await openMenu("Agent");
    expect(menuLabels()).toEqual(["Duplicate", "Delete"]);
    await clickAction("Delete");
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "/api/bots/agent", method: "DELETE" }));
    expect(latest.state.bots).toHaveLength(0);
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it.each(["Escape", "outside", "blur"] as const)("dismisses Tasks rename with %s without persisting", async (dismissal) => {
    await switchTab("Tasks");
    const opener = await openMenu("Older chat");
    await clickAction("Rename Chat");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Chat name"]')!;
    expect(document.activeElement).toBe(input);
    request.mockClear();
    await act(() => {
      if (dismissal === "outside") document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      else window.dispatchEvent(dismissal === "Escape"
        ? new KeyboardEvent("keydown", { key: "Escape" }) : new Event("blur"));
    });
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
    if (dismissal === "Escape") expect(document.activeElement).toBe(opener);
    expect(request).not.toHaveBeenCalled();
  });

  it("retains rename's IME Enter guard in Tasks", async () => {
    await switchTab("Tasks");
    await openMenu("Older chat");
    await clickAction("Rename Chat");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Chat name"]')!;
    const composingEnter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    await act(() => input.dispatchEvent(composingEnter));
    expect(composingEnter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("persists manual marks through selected-chat announcements and hydration, then reads only that chat", async () => {
    for (const title of ["Older chat", "Current chat"]) {
      await openMenu(title);
      await clickAction("Mark message as unread");
    }
    expect(latest.state.bots[0].tasks!.map((task) => task.unread)).toEqual([true, true]);
    await act(() => onEvent({ kind: "bot", bot: structuredClone(serverBot) }));
    expect(latest.state.bots[0].unread).toBe(true);
    expect(request.mock.calls.filter(([call]) => call.body === '{"unread":false}')).toHaveLength(0);
    await act(() => root.unmount());
    document.body.replaceChildren();
    await mount();
    expect(latest.state.bots[0].tasks!.map((task) => task.unread)).toEqual([true, true]);
    await act(() => row("Current chat").click());
    expect(serverBot.tasks!.map((task) => task.unread)).toEqual([false, true]);
    expect(latest.state.bots[0].tasks!.map((task) => task.unread)).toEqual([false, true]);
  });

  it("shows inactive unread rows in the unread filter and opens the owner profile without reading them", async () => {
    await openMenu("Older chat");
    await clickAction("Mark message as unread");
    await act(() => row("unread").click());
    expect(document.querySelector("section")?.textContent).toContain("Older chat");
    expect(document.querySelector("section")?.textContent).not.toContain("Current chat");
    await openMenu("Older chat");
    await clickAction("Edit profile");
    expect(latest.state.activeView).toBe("agents");
    expect(latest.state.selectedId).toBe("agent");
    expect(serverBot.tasks![1].unread).toBe(true);
  });

  it("surfaces persistence failure without leaving a false unread badge", async () => {
    failPatch = true;
    await openMenu("Older chat");
    await clickAction("Mark message as unread");
    expect(latest.state.error).toBe("Could not save chat");
    expect(latest.state.bots[0].tasks![1].unread).not.toBe(true);
  });

  it("still auto-reads activity updates for the selected chat without clearing other chats", async () => {
    serverBot.unread = true;
    serverBot.tasks![0].unread = true;
    serverBot.tasks![1].unread = true;
    serverBot.tasks![1].unreadSource = "manual";
    await act(() => onEvent({ kind: "bot", bot: structuredClone(serverBot) }));
    expect(serverBot.tasks!.map((task) => task.unread)).toEqual([false, true]);
    expect(latest.state.bots[0].tasks!.map((task) => task.unread)).toEqual([false, true]);
  });

  it("reports a failed automatic read update", async () => {
    failPatch = true;
    serverBot.unread = true;
    serverBot.tasks![0].unread = true;
    await act(() => onEvent({ kind: "bot", bot: structuredClone(serverBot) }));
    expect(latest.state.error).toBe("Could not mark chat as read: Could not save chat");
  });
});
