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

describe("Chats menu with the live store", () => {
  it("keeps keyboard opening, initial focus and Escape focus restoration", async () => {
    const opener = await openMenu("Older chat");
    expect(menuLabels()).toEqual(["Rename Chat", "Delete Chat", "Mark message as unread", "Edit profile", "Copy Conversation Id"]);
    expect(document.activeElement?.textContent).toBe("Rename Chat");
    await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("submits the clicked inactive chat's edited title and closes the menu", async () => {
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
    expect(document.querySelector("[data-bot-menu]")).toBeNull();
  });

  it("retains the full Tasks menu after switching tabs", async () => {
    await act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Tasks"]')!.click());
    await openMenu("Older chat");
    expect(menuLabels()).toEqual(["Rename chat", "Delete chat", "Pin agent", "Move agent to context",
      "Mark agent as unread", "Edit Profile", "Duplicate agent", "Copy conversation ID", "Archive agent", "Delete agent"]);
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
