/* oxlint-disable anti-slop/no-module-mocking -- Isolate run rendering from live transport. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, type CoordinationRun, type Group } from "@/state/store";
import { CoordinatorMissionControl } from "./CoordinatorMissionControl";
import { isCoordinatorMessage } from "./GroupView";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: initialState, dispatch: vi.fn() }),
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { label: "Browser" } } }),
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallOverlay: () => null }));

function render(mode: "routing" | "direct" | "planned", escalation = false, overrides: Partial<CoordinationRun> = {}) {
  const run: CoordinationRun = {
    id: "run", groupId: "channel", goal: "Hello", status: mode === "routing" ? "planning" : "running",
    executionMode: mode, roles: {}, requestedBotIds: [], createdAt: 1, fixCycles: 0, planRevisions: [], events: [],
    policySnapshot: { maxConcurrency: 2, maxFixCycles: 2, requirePlanApproval: false, planningRetries: 0,
      maxRunMinutes: 5, requireHighRiskReview: true, failureMode: "pause" },
    coordinatorSnapshot: { requestedModel: { instanceId: "test", model: "m" }, modelPolicyVersion: 1,
      promptVersion: "v7", runtimePolicyVersion: 5, planningBudget: { timeoutMs: 1000 } },
    tasks: mode === "routing" ? [] : [{ id: "direct", title: "Answer", description: "Answer directly",
      role: "responder", botId: "atlas", botName: "Atlas", status: "running", dependsOn: [], attempt: 1 }],
    dispatch: mode === "direct" ? { taskId: "direct", state: "conversation",
      escalation: escalation ? { reason: "Needs dependencies", evidence: "Read file", completedActions: [], remainingWork: "Follow up" } : undefined } : undefined,
  };
  const group: Group = { id: "channel", threadId: "channel-thread", name: "Channel", memberIds: [],
    bulletin: "", unread: false, createdAt: 1, messages: [], coordination: { ...run, ...overrides } };
  return renderToStaticMarkup(createElement(CoordinatorMissionControl, { group }));
}

describe("adaptive Channel progress", () => {
  it("shows routing rather than claiming a DAG is being planned", () => {
    expect(render("routing")).toContain(">Routing<");
  });
  it("shows direct assignment without a DAG icon or task counter", () => {
    const markup = render("direct");
    expect(markup).toContain("Direct dispatch");
    expect(markup).not.toContain("lucide-git-branch");
    expect(markup).not.toContain("0/1");
  });
  it("shows escalation rather than direct completion", () => {
    expect(render("direct", true)).toContain("Escalating to plan");
  });
  it("keeps planned-run presentation", () => {
    expect(render("planned")).toContain("lucide-git-branch");
  });
  it("requires inspection instead of offering to replay an uncertain direct assignment", () => {
    const markup = render("direct", false, { status: "failed" });
    expect(markup).not.toContain('title="Retry run"');
    expect(markup).toContain("Inspect the agent session");
  });
  it("keeps a worker with an execution receipt attributed to that worker", () => {
    expect(isCoordinatorMessage({ id: "reply", role: "bot", kind: "text", at: 1, executionReport: "Receipt",
      from: { botId: "atlas", name: "Atlas", color: "blue" } })).toBe(false);
    expect(isCoordinatorMessage({ id: "legacy", role: "bot", kind: "text", at: 1, executionReport: "Legacy receipt" })).toBe(true);
  });
});
