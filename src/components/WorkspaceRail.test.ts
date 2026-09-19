import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRail, type WorkspaceView } from "./WorkspaceRail";

function renderRail(view: WorkspaceView = "chats") {
  return renderToStaticMarkup(createElement(WorkspaceRail, {
    view, onChangeView: vi.fn(), onOpenSettings: vi.fn(),
  }));
}

describe("workspace rail", () => {
  it("keeps navigation permanently visible without a pane toggle", () => {
    const markup = renderRail();
    expect(markup).not.toContain("navigation pane");
    expect(markup).not.toContain("panel-left");
    expect(markup).toContain('aria-label="Chats"');
    expect(markup).toContain('aria-label="Channels"');
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).toContain("pt-1.5");
    expect(markup).toContain("bg-inset/50");
    expect(markup).not.toContain("border-r");
    expect(markup).not.toContain('aria-hidden="true" class="h-11 shrink-0"');
  });

  it.each([
    ["chats", "Chats"],
    ["channels", "Channels"],
    ["tasks", "Tasks"],
    ["agents", "Agents"],
  ] as const)("uses the same icon-only selected treatment for %s", (view, label) => {
    const markup = renderRail(view);
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
    const markup = renderRail("channels");
    const chatButton = markup.match(/<button\b[^>]*aria-label="Chats"[\s\S]*?<\/button>/)?.[0];
    expect(chatButton?.replace(/<[^>]*>/g, "")).toBe("");
    expect(chatButton).toContain('title="Chats"');
    expect(chatButton).toContain('fill="none"');
    expect(chatButton).not.toContain('aria-current="page"');
    expect(chatButton).not.toContain("bg-current");
    expect(chatButton).not.toContain("text-nav-selected");
  });
});
