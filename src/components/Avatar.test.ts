import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAUS_COLORS, MAUS_COLOR_NAMES } from "@/lib/mascot";
import { BotAvatar, MausAvatar } from "./Avatar";
import { CursorAvatar, DEFAULT_SILHOUETTE } from "./CursorAvatar";

describe("default robot avatars", () => {
  it.each(MAUS_COLOR_NAMES)("uses the robot with the saved %s color", (color) => {
    const html = renderToStaticMarkup(createElement(BotAvatar, {
      bot: { name: "Existing bot", color },
      size: 36,
      animated: false,
    }));
    expect(html).toContain(DEFAULT_SILHOUETTE.clip);
    expect(html).toContain(`stop-color="${MAUS_COLORS[color]}"`);
    expect(html).toContain('fill="#142539"');
    expect(html).toContain('aria-label="Existing bot"');
    expect(html).toContain('width="36px"');
    expect(html).not.toContain("{{");
    expect(html).not.toContain("<img");
  });

  it("uses the same robot in expression and color previews", () => {
    const html = renderToStaticMarkup(createElement(MausAvatar, {
      color: "purple",
      state: "happy",
      animated: false,
    }));
    expect(html).toContain(DEFAULT_SILHOUETTE.clip);
  });

  it("gives an unnamed standalone robot an accessible label", () => {
    const html = renderToStaticMarkup(createElement(CursorAvatar, { paused: true }));
    expect(html).toContain('aria-label="roundtable robot mascot"');
  });

  it("keeps a chosen custom image", () => {
    const html = renderToStaticMarkup(createElement(BotAvatar, {
      bot: {
        name: "Custom bot",
        color: "blue",
        avatarUrl: "/api/attachments/custom.png",
        avatarCrop: "circle",
      },
    }));
    expect(html).toContain("<img");
    expect(html).toContain("/api/attachments/custom.png");
    expect(html).not.toContain("<svg");
  });

  it("shows the robot when the mascot is selected over a saved image", () => {
    const html = renderToStaticMarkup(createElement(BotAvatar, {
      bot: {
        color: "green",
        avatarUrl: "/api/attachments/custom.png",
        avatarCrop: "mascot",
      },
    }));
    expect(html).toContain(DEFAULT_SILHOUETTE.clip);
    expect(html).not.toContain("<img");
  });
});
