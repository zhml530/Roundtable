import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRail, type WorkspaceView } from "./WorkspaceRail";

function renderRail(paneOpen: boolean, view: WorkspaceView = "chats") {
  return renderToStaticMarkup(createElement(WorkspaceRail, {
    paneOpen, paneId: "navigation-pane", view,
    onTogglePane: vi.fn(), onChangeView: vi.fn(), onOpenSettings: vi.fn(),
  }));
}

describe("workspace rail", () => {
  it.each([
    [true, "Hide navigation pane", "panel-left-close"],
    [false, "Show navigation pane", "panel-left-open"],
  ] as const)("exposes the %s pane state with a distinct toggle", (open, label, icon) => {
    const markup = renderRail(open);
    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(`title="${label}"`);
    expect(markup).toContain(`aria-expanded="${open}"`);
    expect(markup).toContain('aria-controls="navigation-pane"');
    expect(markup).toContain(`lucide-${icon}`);
    expect(markup).toContain('aria-label="Chats"');
    expect(markup).toContain('aria-label="Channels"');
    expect(markup).toContain('aria-label="Settings"');
  });

  it.each([
    ["chats", "Chats"],
    ["channels", "Channels"],
    ["tasks", "Tasks"],
    ["agents", "Agents"],
  ] as const)("uses the same icon-only selected treatment for %s", (view, label) => {
    const markup = renderRail(true, view);
    const selectedButton = markup.match(new RegExp(`<button\\b[^>]*aria-label="${label}"[\\s\\S]*?<\\/button>`))?.[0];
    expect(selectedButton).toBeDefined();
    expect(selectedButton).toContain(`title="${label}"`);
    expect(selectedButton).toContain('aria-current="page"');
    expect(selectedButton).toContain("text-nav-selected");
    expect(selectedButton).toContain('fill="none"');
    expect(selectedButton).toContain('stroke="currentColor"');
    expect(selectedButton).toContain("rounded-full bg-current");
    expect(selectedButton).not.toContain("bg-accent");
    expect(selectedButton).not.toContain("text-white");
    expect(selectedButton?.replace(/<[^>]*>/g, "")).toBe("");
    expect(selectedButton).toContain("h-11 w-12");
    expect(markup.match(/rounded-full bg-current/g)).toHaveLength(1);
  });

  it("keeps an accessible Chats name but removes its selection treatment on other views", () => {
    const markup = renderRail(false, "channels");
    const chatButton = markup.match(/<button\b[^>]*aria-label="Chats"[\s\S]*?<\/button>/)?.[0];
    expect(chatButton?.replace(/<[^>]*>/g, "")).toBe("");
    expect(chatButton).toContain('title="Chats"');
    expect(chatButton).toContain('fill="none"');
    expect(chatButton).not.toContain('aria-current="page"');
    expect(chatButton).not.toContain("bg-current");
    expect(chatButton).not.toContain("text-nav-selected");
  });
});
