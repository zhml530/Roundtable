import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPicker } from "./ModelPicker";
import { EnginesSettings } from "./EnginesSettings";
import { EngineSetup, needsSignIn } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], openControls: true }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture, dispatch: vi.fn(), refreshInstances: vi.fn() }),
  api: vi.fn(),
}));
// Render the open picker and CLI editor without browser effects or network.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => react.useState(initial === false ? fixture.openControls : initial) };
});

describe("BugFlow UI wiring", () => {
  beforeEach(() => {
    fixture.openControls = true;
    vi.stubGlobal("window", { ogb: { platform: "win32" } });
    fixture.instances = [{
      instanceId: "bugflow", driverKind: "bugflowAgent", displayName: "BugFlow Agent",
      snapshot: { state: "available", authenticated: true },
      models: { default: "bugflow-default", options: [{ id: "bugflow-default", label: "BugFlow (agent-controlled)" }] },
      capabilities: { customModels: false, explicitApprovals: true, images: false, files: false },
      cliDefault: "bugflow-agent",
    }];
  });

  it("shows the fixed model and hides local model injection", () => {
    const bot = { modelSelection: { instanceId: "bugflow", model: "bugflow-default" } } as Bot;
    const html = renderToStaticMarkup(createElement(ModelPicker, { bot }));
    expect(html).toContain("BugFlow (agent-controlled)");
    expect(html).not.toContain("Use a local model");
    expect(html).toContain('data-provider-mark="bugflow"');
    expect(html).not.toContain("lucide-bug");
    fixture.instances[0].capabilities!.customModels = undefined;
    expect(renderToStaticMarkup(createElement(ModelPicker, { bot }))).toContain("Use a local model");
  });

  it("hides installation guidance until Set CLI is expanded", () => {
    fixture.openControls = false;
    const closed = renderToStaticMarkup(createElement(EnginesSettings));
    expect(closed).toContain("Set CLI");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Standalone Windows EXE");
    expect(closed).not.toContain("Requires Git");
    fixture.openControls = true;
    const opened = renderToStaticMarkup(createElement(EnginesSettings));
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain("Standalone Windows EXE");
  });

  it("uses a scalable outline mark for BugFlow without changing Copilot's icon", () => {
    const mark = renderToStaticMarkup(createElement(ProviderMark, {
      driverKind: "bugflowAgent", size: 24, className: "preview-mark",
    }));
    expect(mark).toContain('width="24"');
    expect(mark).toContain('fill="none"');
    expect(mark).toContain('stroke="currentColor"');
    expect(mark).toContain("preview-mark");
    expect(mark).not.toContain("lucide-bug");
    expect(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "copilotAgent" }))).toContain("lucide-github");
  });

  it("offers the standalone installer alongside the BugFlow CLI path editor", () => {
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("BugFlow Agent custom CLI path");
    expect(html).not.toContain("Managed through SSH");
    expect(html).toContain("Standalone Windows EXE");
    expect(html).toContain("builds a new EXE locally every time");
    fixture.instances[0].driverKind = "geminiAgent";
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("Standalone Windows EXE");
  });

  it("shows the actionable host message instead of treating installed as authenticated", () => {
    const instance = fixture.instances[0];
    instance.snapshot = { state: "available", authenticated: false, reason: "Complete BRB login in BugFlow." };
    expect(needsSignIn(instance)).toBe(true);
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance }));
    expect(html).toContain("Complete BRB login in BugFlow.");
    expect(html).not.toContain("Use a local model");
  });
});
