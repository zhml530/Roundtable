import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { remoteComputerBootstrapCommand, semanticBrowserCommand } from "./remote-computer.ts";

describe("remote computer setup", () => {
  it("bootstraps the retained X11 and Chrome DevTools controls", () => {
    const command = remoteComputerBootstrapCommand("Test Bot");
    expect(command).toContain("xdotool");
    expect(command).toContain("imagemagick");
    expect(command).toContain("Roundtable-cdp.mjs");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
    }
  });

  it("encodes semantic browser input instead of interpolating it into shell", () => {
    const command = semanticBrowserCommand("fill", { ref: "b7", text: "don't expand $HOME" });
    expect(command).toContain("Roundtable-cdp.mjs fill");
    expect(command).not.toContain("don't expand");
    expect(command).not.toContain("$HOME");
  });
});

