import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { ChannelAvatar } from "./ChannelAvatar";

const members = ["Reviewer", "Planner", "Executor", "Researcher"].map((name, index): BotAvatarProps["bot"] & { id: string } => ({
  id: `bot-${index}`,
  name,
  color: "green",
  avatarUrl: `/api/attachments/${name}.png`,
  avatarCrop: "circle",
}));

function render(count: number, size = 32, busyBotId?: string) {
  return renderToStaticMarkup(createElement(ChannelAvatar, { members: members.slice(0, count), size, busyBotId }));
}

function gridAreas(html: string): string[] {
  return [...html.matchAll(/grid-area:([^"]+)/g)].map((match) => match[1]!);
}

describe("ChannelAvatar", () => {
  it("uses a neutral channel icon when no members exist", () => {
    const html = render(0);
    expect(html).toContain('aria-label="0 bots"');
    expect(html).toContain("lucide-users");
    expect(gridAreas(html)).toEqual([]);
  });

  it("fills the whole avatar for one member", () => {
    expect(gridAreas(render(1))).toEqual(["1 / 1 / 3 / 3"]);
  });

  it("splits two members into equal left and right halves", () => {
    expect(gridAreas(render(2))).toEqual(["1 / 1 / 3 / 2", "1 / 2 / 3 / 3"]);
  });

  it.each([28, 32, 36])("gives the first member half and the next two a quarter at size %i", (size) => {
    const html = render(3, size);
    expect(html).toContain(`width:${size}px;height:${size}px`);
    expect(gridAreas(html)).toEqual(["1 / 1 / 3 / 2", "1 / 2 / 2 / 3", "2 / 2 / 3 / 3"]);
    const areas = gridAreas(html).map((area) => {
      const [rowStart, columnStart, rowEnd, columnEnd] = area.split(" / ").map(Number);
      return (rowEnd! - rowStart!) * (columnEnd! - columnStart!) / 4;
    });
    expect(areas).toEqual([0.5, 0.25, 0.25]);
    expect(html.indexOf("Reviewer.png")).toBeLessThan(html.indexOf("Planner.png"));
    expect(html.indexOf("Planner.png")).toBeLessThan(html.indexOf("Executor.png"));
    expect(html.match(/border-radius:0/g)).toHaveLength(3);
  });

  it("shows only the first three images but keeps the full count and names in the tooltip", () => {
    const html = render(4);
    expect(gridAreas(html)).toHaveLength(3);
    expect(html).not.toContain("Researcher.png");
    expect(html).toContain('title="4 bots: Reviewer, Planner, Executor, Researcher"');
    expect(html).not.toContain("+1");
  });

  it("uses member order rather than role name or creation order", () => {
    const html = renderToStaticMarkup(createElement(ChannelAvatar, { members: [members[2]!, members[0]!, members[1]!] }));
    expect(html.indexOf("Executor.png")).toBeLessThan(html.indexOf("Reviewer.png"));
    expect(html.indexOf("Reviewer.png")).toBeLessThan(html.indexOf("Planner.png"));
  });

  it("retains the working-member indicator", () => {
    const html = render(3, 32, "bot-1");
    expect(html).toContain("Planner is working");
    expect(html).toContain("border-app bg-accent");
  });

  it("renders the mascot when a member has no custom image", () => {
    const html = renderToStaticMarkup(createElement(ChannelAvatar, {
      members: [{ id: "default", name: "Default bot", color: "blue" }],
    }));
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });

  it("keeps standalone bot images circular by default", () => {
    const html = renderToStaticMarkup(createElement(BotAvatar, { bot: members[0]! }));
    expect(html).toContain("border-radius:50%");
  });
});
