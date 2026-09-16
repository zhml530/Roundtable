import { describe, expect, it } from "vitest";
import {
  MESSAGE_VIEWPORT_INDEX_BASE,
  reconcileFirstItemIndex,
  viewportItemIndexForMessage,
} from "./message-viewport";

const item = (key: string, ...messageIds: string[]) => ({ key, messageIds });

describe("reconcileFirstItemIndex", () => {
  it("preserves the logical index when rows append", () => {
    expect(reconcileFirstItemIndex("a", 900, [item("a"), item("b"), item("c")])).toBe(900);
  });

  it("moves the logical index back by the number of prepended rows", () => {
    expect(reconcileFirstItemIndex("c", 900, [item("a"), item("b"), item("c")])).toBe(898);
  });

  it("starts a fresh index space for a replacement or branch switch", () => {
    expect(reconcileFirstItemIndex("old", 900, [item("new")])).toBe(MESSAGE_VIEWPORT_INDEX_BASE);
  });
});

describe("viewportItemIndexForMessage", () => {
  it("finds messages nested in a grouped turn row", () => {
    expect(viewportItemIndexForMessage([item("turn", "tool-1", "answer")], "answer")).toBe(0);
  });
});
