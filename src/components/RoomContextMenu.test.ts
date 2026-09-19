// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- Isolate menu interactions while exercising the real reducer's topic-local updates. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Action, type Group } from "@/state/store";
import { RoomContextMenu } from "./Sidebar";

let state = initialState;
const dispatch = vi.fn((action: Action) => { state = reducer(state, action); });
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state, dispatch }),
}));

const channel: Group = {
  id: "channel", channelId: "channel", topicName: "General", threadId: "general-thread",
  name: "Engineering", memberIds: [], bulletin: "", unread: false, createdAt: 1, messages: [],
};
const topic: Group = { ...channel, id: "release", topicName: "Release", threadId: "release-thread" };
let root: Root;
const onClose = vi.fn();

async function mount(groupId = topic.id) {
  await act(() => root.render(createElement(RoomContextMenu, {
    menu: { groupId, x: 100, y: 100 }, onClose,
  })));
}

async function click(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-room-menu] button"))
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label);
  expect(button).toBeDefined();
  await act(() => button!.click());
}

async function edit(value: string) {
  const input = document.querySelector("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = { ...initialState, groups: [channel, topic, { ...topic, id: "sibling", topicName: "Planning" }] };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Room menu rename and delete", () => {
  it.each(["Enter", "Save"])("renames only the clicked topic using %s", async (method) => {
    await mount();
    await click("Rename Topic");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Rename topic Release"]')!;
    expect(input.value).toBe("Release");
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[aria-label="Cancel topic rename"]')).not.toBeNull();
    await edit("  Launch  ");
    if (method === "Save") await click("Save topic name");
    else await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "patchGroup", groupId: topic.id, patch: { topicName: "Launch" } },
    ]);
    expect(state.groups.map((group) => group.topicName)).toEqual(["General", "Launch", "Planning"]);
    expect(state.groups.map((group) => group.name)).toEqual(["Engineering", "Engineering", "Engineering"]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(["Release", " Release ", "   "])("does not patch an unchanged or empty topic draft: %j", async (draft) => {
    await mount();
    await click("Rename Topic");
    await edit(draft);
    await click("Save topic name");
    expect(dispatch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("can rename a topic to the channel's name", async () => {
    await mount();
    await click("Rename Topic");
    await edit(channel.name);
    await click("Save topic name");
    expect(dispatch).toHaveBeenCalledWith({ type: "patchGroup", groupId: topic.id, patch: { topicName: channel.name } });
  });

  it.each(["Cancel", "Escape"])("cancels topic rename with %s without patching", async (method) => {
    await mount();
    await click("Rename Topic");
    const input = await edit("Not saved");
    if (method === "Cancel") await click("Cancel topic rename");
    else await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dispatch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it.each([channel, { ...channel, channelId: undefined, topicName: undefined }])(
    "keeps General and legacy channel rename semantics (%j)", async (group) => {
      state = { ...state, groups: [group, topic] };
      await mount(group.id);
      await click("Rename Channel");
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Rename channel Engineering"]')?.value).toBe("Engineering");
      expect(document.querySelector('[aria-label="Cancel channel rename"]')).not.toBeNull();
      await edit("Product");
      await click("Save channel name");
      expect(dispatch).toHaveBeenCalledWith({ type: "patchGroup", groupId: channel.id, patch: { name: "Product" } });
      expect(state.groups[1].topicName).toBe("Release");
    },
  );

  it.each([[topic.id, "Delete Topic"], [channel.id, "Delete Channel"]])("deletes the exact %s target", async (id, label) => {
    await mount(id);
    await click(label);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "deleteGroup", groupId: id }]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
