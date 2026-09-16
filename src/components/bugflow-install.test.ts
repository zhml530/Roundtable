import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BugFlowInstallCard } from "./BugFlowInstall";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: vi.fn() }));

describe("BugFlow standalone installation settings", () => {
  it("offers a fresh EXE build, not an editable Python runtime install", () => {
    const html = renderToStaticMarkup(createElement(BugFlowInstallCard, {
      status: { state: "idle", phase: "idle", message: "", progress: 0 },
      busy: false, installed: false, onInstall: () => {},
    }));
    expect(html).toContain("Install fresh EXE");
    expect(html).toContain("Python 3.12 x64");
    expect(html).toContain("installed EXE needs no Python");
    expect(html).toContain("Azure CLI");
    expect(html).toContain("Existing hosts keep running");
  });
  it("shows bounded progress and disables a second install", () => {
    const html = renderToStaticMarkup(createElement(BugFlowInstallCard, {
      status: { state: "running", phase: "build", message: "Building fresh EXE", progress: 55 },
      busy: true, installed: true, onInstall: () => {},
    }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('value="55"');
    expect(html).toContain("Building fresh EXE");
  });
  it("keeps a rebuild action and actionable error after failure", () => {
    const html = renderToStaticMarkup(createElement(BugFlowInstallCard, {
      status: { state: "failed", phase: "source", message: "Source access required. Previous installation preserved.", progress: 10 },
      busy: false, installed: true, onInstall: () => {},
    }));
    expect(html).toContain("Rebuild &amp; reinstall");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Previous installation preserved");
  });
});
