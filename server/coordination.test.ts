import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assignCoordinationRoles,
  buildCoordinationReport,
  CoordinationManager,
  fallbackPlan,
  normalizeCoordinationPlan,
  reviewApproved,
  type CoordinationBot,
  type CoordinationRun,
} from "./coordination.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bots: CoordinationBot[] = [
  { id: "dev", name: "Dara", title: "Developer", description: "implements features", model: "m" },
  { id: "review", name: "Rae", title: "Code Reviewer", description: "audits changes", model: "m" },
  { id: "arch", name: "Ari", title: "Architect", description: "designs systems", model: "m" },
  { id: "test", name: "Tess", title: "QA Tester", description: "tests acceptance criteria", model: "m" },
];

describe("Coordinator domain", () => {
  it("assigns four distinct bots from profile evidence", () => {
    const roles = assignCoordinationRoles(bots);
    expect(roles.architect.id).toBe("arch");
    expect(roles.developer.id).toBe("dev");
    expect(roles.tester.id).toBe("test");
    expect(roles.reviewer.id).toBe("review");
    expect(new Set(Object.values(roles).map((bot) => bot.id)).size).toBe(4);
  });

  it("rejects a channel that cannot provide all MVP roles", () => {
    expect(() => assignCoordinationRoles(bots.slice(0, 3))).toThrow(/at least four/i);
  });

  it("preserves generated dependencies and adds a terminal review gate", () => {
    const plan = normalizeCoordinationPlan({
      version: 1,
      goal: "ship",
      tasks: [
        { id: "a", title: "Architecture", description: "design", assignee: "architect" },
        { id: "b", title: "Build", description: "implement", assignee: "developer", dependsOn: ["a"] },
      ],
    }, "ship");
    expect(plan.tasks.map((task) => task.id)).toEqual(expect.arrayContaining(["a", "b"]));
    const review = plan.tasks.at(-1)!;
    expect(review.role).toBe("reviewer");
    expect(review.dependsOn).toEqual(["b"]);
  });

  it("recognizes only an explicit approving reviewer verdict", () => {
    expect(reviewApproved("Looks good\nVERDICT: APPROVED")).toBe(true);
    expect(reviewApproved("VERDICT: CHANGES_REQUESTED\nFix tests")).toBe(false);
    expect(reviewApproved("probably okay")).toBe(false);
  });

  it("provides a deterministic four-stage fallback DAG", () => {
    const plan = fallbackPlan("demo");
    expect(plan.tasks.map((task) => task.role)).toEqual(["architect", "developer", "tester", "reviewer"]);
    expect(plan.tasks[3]?.dependsOn).toEqual(["verification"]);
  });

  it("builds a report with task receipts and a timeline", () => {
    const run: CoordinationRun = {
      id: "run", groupId: "room", goal: "ship", status: "completed", fixCycles: 0,
      roles: {
        architect: { botId: "arch", botName: "Ari" }, developer: { botId: "dev", botName: "Dara" },
        tester: { botId: "test", botName: "Tess" }, reviewer: { botId: "review", botName: "Rae" },
      },
      tasks: [{ id: "t", title: "Build", description: "build", role: "developer", botId: "dev", botName: "Dara", dependsOn: [], status: "completed", attempt: 1 }],
      events: [{ id: "e", at: 1, type: "task", message: "Build completed", taskId: "t" }],
      createdAt: 0, startedAt: 0, finishedAt: 1000,
    };
    const report = buildCoordinationReport(run);
    expect(report).toContain("Coordinator report — completed");
    expect(report).toContain("Build — Dara (developer)");
    expect(report).toContain("## Timeline");
  });

  it("runs a generated OMA plan through detached Roundtable bot tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-"));
    dirs.push(dir);
    let calls = 0;
    let threads = 0;
    const channelMessages: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => bots,
      createTask: () => ({ threadId: `thread-${++threads}` }),
      runBotTurn: async () => {
        calls += 1;
        if (calls === 1) return { text: JSON.stringify([
          { title: "Design", description: "Design interfaces", assignee: "architect", role: "architect" },
          { title: "Build", description: "Implement design", assignee: "developer", role: "developer", dependsOn: ["Design"] },
          { title: "Test", description: "Verify build", assignee: "tester", role: "tester", dependsOn: ["Build"] },
          { title: "Review", description: "Review evidence", assignee: "reviewer", role: "reviewer", dependsOn: ["Test"] },
        ]) };
        return { text: calls >= 5 ? "VERDICT: APPROVED" : `worker output ${calls}` };
      },
      appendChannelMessage: (_groupId, text) => channelMessages.push(text),
    });

    await manager.start("room", "Ship the demo");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("completed"), { timeout: 5_000 });
    const run = manager.latest("room")!;
    expect(run.tasks.filter((task) => task.id !== "planning")).toHaveLength(4);
    expect(run.tasks.every((task) => task.threadId)).toBe(true);
    expect(run.tasks.at(-1)?.role).toBe("reviewer");
    expect(channelMessages.at(-1)).toContain("Coordinator report — completed");
  });

  it("turns reviewer rejection into an automatic fix, test, and re-review chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-fix-"));
    dirs.push(dir);
    let calls = 0;
    let threads = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => bots,
      createTask: () => ({ threadId: `thread-${++threads}` }),
      runBotTurn: async () => {
        calls += 1;
        if (calls === 1) return { text: JSON.stringify([
          { title: "Design", description: "Design", assignee: "architect" },
          { title: "Build", description: "Build", assignee: "developer", dependsOn: ["Design"] },
          { title: "Test", description: "Test", assignee: "tester", dependsOn: ["Build"] },
          { title: "Review", description: "Review", assignee: "reviewer", dependsOn: ["Test"] },
        ]) };
        if (calls === 5) return { text: "Missing edge-case coverage\nVERDICT: CHANGES_REQUESTED" };
        if (calls >= 8) return { text: "VERDICT: APPROVED" };
        return { text: `worker output ${calls}` };
      },
    });

    await manager.start("room", "Ship with review gate");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("completed"), { timeout: 5_000 });
    const run = manager.latest("room")!;
    expect(run.fixCycles).toBe(1);
    expect(run.tasks).toHaveLength(7);
    expect(run.tasks.slice(-3).map((task) => task.role)).toEqual(["developer", "tester", "reviewer"]);
    expect(run.events.some((event) => event.message.includes("generating Fix tasks"))).toBe(true);
  });

  it("drains into pause before dispatching workers and resumes the frozen DAG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-pause-"));
    dirs.push(dir);
    let calls = 0;
    let releasePlanning!: () => void;
    const planningGate = new Promise<void>((resolve) => { releasePlanning = resolve; });
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => bots,
      createTask: (_botId, title) => ({ threadId: title }),
      runBotTurn: async () => {
        calls += 1;
        if (calls === 1) {
          await planningGate;
          return { text: JSON.stringify([
            { title: "Design", description: "Design", assignee: "architect" },
            { title: "Build", description: "Build", assignee: "developer", dependsOn: ["Design"] },
            { title: "Test", description: "Test", assignee: "tester", dependsOn: ["Build"] },
            { title: "Review", description: "Review", assignee: "reviewer", dependsOn: ["Test"] },
          ]) };
        }
        return { text: calls >= 5 ? "VERDICT: APPROVED" : "done" };
      },
    });

    await manager.start("room", "Pause safely");
    await vi.waitFor(() => expect(calls).toBe(1));
    manager.pause("room");
    releasePlanning();
    await vi.waitFor(() => {
      expect(manager.latest("room")?.status).toBe("paused");
      expect(manager.latest("room")?.tasks).toHaveLength(4);
    });
    expect(calls).toBe(1);
    manager.resume("room");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("completed"), { timeout: 5_000 });
    expect(calls).toBe(5);
  });
});
