import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assignCoordinationRoles,
  buildCoordinationReport,
  buildCoordinationAnswer,
  CoordinationManager,
  fallbackPlan,
  implementationRequested,
  normalizeCoordinationPlan,
  reviewApproved,
  validateCoordinationPlan,
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
const policy = () => ({
  primary: { instanceId: "coordinator", model: "planner" },
  failureMode: "pause" as const,
  planningTimeoutMs: 10_000,
  planningRetries: 0,
  maxConcurrency: 4,
  maxFixCycles: 2,
  maxRunMinutes: 60,
  requireHighRiskReview: true,
});

describe("Coordinator domain", () => {
  it("keeps research and summaries out of automatic implementation loops", () => {
    expect(implementationRequested("Evaluate VLM feasibility and propose an evaluation plan")).toBe(false);
    expect(implementationRequested("I need the summary, don't implement anything")).toBe(false);
    expect(implementationRequested("Now fix the project summary delivery issues")).toBe(true);
    expect(fallbackPlan("Investigate architecture feasibility").tasks).toHaveLength(1);
  });

  it.each([
    ["Evaluate VLM feasibility", 0],
    ["Implement a video pipeline", 2],
  ])("separates review rejection from execution completion for %s", async (goal, cycles) => {
    const dir = mkdtempSync(join(tmpdir(), "channel-review-")); dirs.push(dir);
    const receipts: Array<{ text: string; report?: string }> = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      synthesize: true,
      runCoordinatorTurn: async ({ purpose }) => ({ text: purpose === "synthesis" ? "Prototype evidence is incomplete; real measurements remain pending." : JSON.stringify([
        { id: "findings", title: "Findings", description: "Assess evidence", role: "architect" },
        { id: "review", title: "Review", description: "Check findings", role: "reviewer", dependsOn: ["findings"] },
      ]) }),
      createTask: (id) => ({ threadId: id }),
      runBotTurn: async () => ({ text: "Missing evidence. VERDICT: CHANGES_REQUESTED" }),
      appendChannelMessage: (_id, text, run) => receipts.push({ text, report: run?.report }),
    });
    const run = await manager.start("room", goal);
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(run.fixCycles).toBe(cycles);
    expect(run.reviewStatus).toBe("changes_requested");
    expect(receipts.at(-1)?.text).toContain("Prototype evidence");
    expect(receipts.at(-1)?.text).toContain("without review acceptance");
    expect(receipts.at(-1)?.text).not.toContain("## Timeline");
    expect(receipts.at(-1)?.report).toContain("## Timeline");
  });

  it("overlaps independent same-role tasks, refills two slots, gates dependencies, and tracks every mentioned bot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-duo-"));
    dirs.push(dir);
    const crew = [...bots, { ...bots[0]!, id: "dev2", name: "Dev Two" }];
    const proposal = [
      { id: "a", title: "A", description: "Inspect module alpha", role: "developer", botId: "dev" },
      { id: "b", title: "B", description: "Inspect module beta", role: "developer", botId: "dev2" },
      { id: "c", title: "C", description: "Inspect interfaces", role: "architect", botId: "arch" },
      { id: "d", title: "D", description: "Verify all findings", role: "tester", botId: "test", dependsOn: ["a", "b", "c"] },
      { id: "e", title: "E", description: "Review all evidence", role: "reviewer", botId: "review", dependsOn: ["d"] },
    ];
    const started: string[] = [];
    const finished = new Set<string>();
    const releases = new Map<string, () => void>();
    const prompts = new Map<string, string>();
    let active = 0;
    let peak = 0;
    const snapshots: CoordinationRun[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => crew,
      coordinatorPolicy: () => ({ ...policy(), maxConcurrency: 16 }),
      runCoordinatorTurn: async () => ({ text: JSON.stringify(proposal) }),
      createTask: (_bot, title) => ({ threadId: title.split(" ").at(-1)!.toLowerCase() }),
      emit: ({ run }) => snapshots.push(structuredClone(run)),
      runBotTurn: async ({ botId, threadId, prompt, signal }) => {
        expect(botId).toBe(proposal.find((task) => task.id === threadId)!.botId);
        for (const dependency of proposal.find((task) => task.id === threadId)!.dependsOn ?? []) expect(finished.has(dependency)).toBe(true);
        started.push(threadId);
        prompts.set(threadId, prompt);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          releases.set(threadId, resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        active -= 1;
        finished.add(threadId);
        return { text: `Result ${threadId}\nVERDICT: APPROVED` };
      },
    });
    try {
      const run = await manager.start("room", "@everyone investigate together");
      await vi.waitFor(() => expect(started).toHaveLength(2));
      expect(peak).toBe(2);
      expect(started).toEqual(expect.arrayContaining(["a", "b"]));
      expect(run.policySnapshot.maxConcurrency).toBe(2);
      expect(run.requestedBotIds).toHaveLength(5);
      expect(new Set(run.tasks.map((task) => task.botId))).toEqual(new Set(crew.map((bot) => bot.id)));
      expect(run.tasks.find((task) => task.id === "c")?.status).toBe("ready");
      expect(run.tasks.find((task) => task.id === "d")?.status).toBe("pending");
      releases.get("a")!();
      await vi.waitFor(() => expect(started).toContain("c"));
      expect(finished.has("b")).toBe(false); // refill without a batch barrier
      expect(started).not.toContain("d");
      releases.get("c")!();
      await vi.waitFor(() => expect(finished.has("c")).toBe(true));
      expect(started).not.toContain("d");
      releases.get("b")!();
      await vi.waitFor(() => expect(started).toContain("d"));
      expect(prompts.get("d")).toContain("Result a");
      expect(prompts.get("d")).toContain("Result b");
      releases.get("d")!();
      await vi.waitFor(() => expect(started).toContain("e"));
      releases.get("e")!();
      await vi.waitFor(() => expect(run.status).toBe("completed"));
      expect(peak).toBe(2);
      expect(snapshots.every((snapshot) => snapshot.tasks.filter((task) => task.status === "running").length <= 2)).toBe(true);
      for (const task of run.tasks) {
        expect(task.output).toContain(`Result ${task.id}`);
        expect(task.threadId).toBe(task.id);
        expect(run.events.some((event) => event.taskId === task.id && event.message.includes("assigned:"))).toBe(true);
      }
      const restored = new CoordinationManager({
        file: join(dir, "runs.json"), groupBots: () => crew, coordinatorPolicy: policy,
        runCoordinatorTurn: async () => ({ text: "[]" }), createTask: () => null,
        runBotTurn: async () => ({ text: "unused" }),
      }).latest("room")!;
      expect(restored.requestedBots).toEqual(crew.map(({ id, name }) => ({ id, name })));
      expect(restored.tasks).toEqual(run.tasks);
    } finally {
      if (["planning", "running", "paused", "reviewing"].includes(manager.latest("room")?.status ?? "")) await manager.cancel("room");
    }
  });

  it("blocks a mention-all plan with missing assignments instead of inventing parallel work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-duo-missing-"));
    dirs.push(dir);
    const runBotTurn = vi.fn(async () => ({ text: "unused" }));
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([{ title: "One", description: "Inspect", role: "developer", botId: "dev" }]) }),
      createTask: () => ({ threadId: "unused" }), runBotTurn,
    });
    const run = await manager.start("room", "@all investigate");
    await vi.waitFor(() => expect(run.status).toBe("planning_blocked"));
    expect(run.error).toContain("omitted an assignment");
    expect(run.requestedBots).toHaveLength(4);
    expect(run.planRevisions[0]?.accepted).toBe(false);
    expect(runBotTurn).not.toHaveBeenCalled();
  });

  it("serializes two independent tasks assigned to the same bot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-duo-bot-lock-"));
    dirs.push(dir);
    let active = 0;
    let peak = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { title: "One", description: "Inspect alpha", role: "developer", botId: "dev" },
        { title: "Two", description: "Inspect beta", role: "developer", botId: "dev" },
      ]) }),
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { text: "VERDICT: APPROVED" };
      },
    });
    const run = await manager.start("room", "Inspect independently");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(peak).toBe(1);
    expect(run.tasks.filter((task) => task.botId === "dev")).toHaveLength(2);
  });

  it("lets an independent branch finish when another fails, but blocks its dependents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-duo-failure-"));
    dirs.push(dir);
    const started: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { id: "a", title: "A", description: "Inspect alpha", role: "developer", botId: "dev" },
        { id: "b", title: "B", description: "Inspect beta", role: "architect", botId: "arch" },
        { id: "c", title: "C", description: "Verify alpha", role: "tester", botId: "test", dependsOn: ["a"] },
      ]) }),
      createTask: (_bot, title) => ({ threadId: title.split(" ").at(-1)! }),
      runBotTurn: async ({ threadId }) => {
        started.push(threadId);
        if (threadId === "A") throw new Error("alpha unavailable");
        return { text: "Independent result" };
      },
    });
    const run = await manager.start("room", "Inspect branches");
    await vi.waitFor(() => expect(run.status).toBe("failed"));
    expect(started).toContain("B");
    expect(started).not.toContain("C");
    expect(run.tasks.find((task) => task.id === "b")?.status).toBe("completed");
    expect(run.tasks.find((task) => task.id === "c")?.status).toBe("blocked");
  });

  it("cancels both workers without starting queued work or accepting a replacement before drain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-duo-cancel-"));
    dirs.push(dir);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { title: "A", description: "Inspect alpha", role: "developer", botId: "dev" },
        { title: "B", description: "Inspect beta", role: "architect", botId: "arch" },
        { title: "C", description: "Inspect gamma", role: "tester", botId: "test" },
      ]) }),
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ threadId }) => {
        started.push(threadId);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { text: "Late result\nVERDICT: APPROVED" };
      },
    });
    const run = await manager.start("room", "Inspect branches");
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2));
      await manager.cancel("room");
      expect(() => manager.validateStart("room", "replacement")).toThrow("active coordination run");
    } finally {
      releases.forEach((release) => release());
    }
    await vi.waitFor(() => expect(() => manager.validateStart("room", "replacement")).not.toThrow());
    expect(started).toHaveLength(2);
    expect(run.status).toBe("cancelled");
    expect(run.tasks.every((task) => task.status === "cancelled")).toBe(true);
  });

  it("assigns four distinct bots from profile evidence", () => {
    const roles = assignCoordinationRoles(bots);
    expect(roles.architect.id).toBe("arch");
    expect(roles.developer.id).toBe("dev");
    expect(roles.tester.id).toBe("test");
    expect(roles.reviewer.id).toBe("review");
    expect(new Set(Object.values(roles).map((bot) => bot.id)).size).toBe(4);
  });

  it("reuses available bots when a channel has fewer than four members", () => {
    const roles = assignCoordinationRoles(bots.slice(0, 1));
    expect(Object.values(roles).every((bot) => bot.id === "dev")).toBe(true);
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

  it("rejects unknown dependencies and cyclic DAGs", () => {
    expect(() => validateCoordinationPlan({
      version: 1, goal: "bad",
      tasks: [{ id: "a", title: "A", description: "A", dependsOn: ["missing"] }],
    })).toThrow("unknown dependency");
    expect(() => validateCoordinationPlan({
      version: 1, goal: "cycle",
      tasks: [
        { id: "a", title: "A", description: "A", dependsOn: ["b"] },
        { id: "b", title: "B", description: "B", dependsOn: ["a"] },
      ],
    })).toThrow("dependency cycle");
  });

  it("provides a one-task fallback for a simple goal", () => {
    const plan = fallbackPlan("demo");
    expect(plan.tasks.map((task) => task.role)).toEqual(["architect"]);
  });

  it("builds a report with task receipts and a timeline", () => {
    const run: CoordinationRun = {
      id: "run", groupId: "room", goal: "ship", status: "completed", fixCycles: 0,
      plannerBotId: "arch", plannerBotName: "Ari", plannerSelectionReason: "profile match",
      requestedBotIds: [], policySnapshot: { maxConcurrency: 4, maxFixCycles: 2, requirePlanApproval: false, planningRetries: 1, maxRunMinutes: 60, requireHighRiskReview: true, failureMode: "pause" },
      coordinatorSnapshot: { requestedModel: { instanceId: "coordinator", model: "planner" }, modelPolicyVersion: 1, promptVersion: "test", runtimePolicyVersion: 1, planningBudget: { timeoutMs: 10_000 } },
      planRevisions: [],
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
    run.tasks[0]!.output = "Keep GPT-4o as the final answerer. Compare historical keyframes first.";
    expect(buildCoordinationAnswer(run)).toBe(run.tasks[0]!.output);
    run.tasks.push({ ...run.tasks[0]!, id: "review", role: "reviewer", title: "Review", dependsOn: ["t"], output: "VERDICT: APPROVED" });
    run.answer = "Project recommendation based on the findings and review.";
    expect(buildCoordinationAnswer(run)).toBe(run.answer);
    run.tasks[1]!.output = "Missing real-screen measurements. VERDICT: CHANGES_REQUESTED";
    expect(buildCoordinationAnswer(run)).toContain("Review remains unresolved");
    expect(buildCoordinationAnswer(run)).toContain("without review acceptance");
    run.tasks.push({ ...run.tasks[0]!, id: "independent", title: "Independent findings", output: "Independent result" });
    expect(buildCoordinationAnswer(run)).toContain(run.answer);
    expect(buildCoordinationAnswer(run)).not.toContain("Independent result");
    run.tasks.push({ ...run.tasks[0]!, id: "summary", title: "Summary", dependsOn: ["t", "review", "independent"], output: "Consolidated recommendation" });
    expect(buildCoordinationAnswer(run)).toContain(run.answer);
    expect(buildCoordinationAnswer(run)).not.toContain("Independent result");
    delete run.answer;
    expect(buildCoordinationAnswer(run)).toContain("consolidated summary is unavailable");
    expect(buildCoordinationAnswer(run)).not.toContain("Consolidated recommendation");
  });

  it("runs a generated OMA plan through detached Roundtable bot tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-"));
    dirs.push(dir);
    let calls = 0;
    let threads = 0;
    const channelMessages: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      synthesize: true,
      groupBots: () => bots,
      coordinatorPolicy: policy,
      runCoordinatorTurn: async ({ purpose, prompt }) => {
        if (purpose === "synthesis") {
          expect(prompt).toContain("worker output 1");
          expect(prompt).toContain("worker output 3");
          expect(prompt).toContain("VERDICT: APPROVED");
          return { text: "The project is implemented and verified.", usage: { input: 20, output: 10 } };
        }
        return { text: JSON.stringify([
        { title: "Design", description: "Design interfaces", assignee: "architect", role: "architect" },
        { title: "Build", description: "Implement design", assignee: "developer", role: "developer", dependsOn: ["Design"] },
        { title: "Test", description: "Verify build", assignee: "tester", role: "tester", dependsOn: ["Build"] },
        { title: "Review", description: "Review evidence", assignee: "reviewer", role: "reviewer", dependsOn: ["Test"] },
      ]) };
      },
      createTask: () => ({ threadId: `thread-${++threads}` }),
      runBotTurn: async () => {
        calls += 1;
        return { text: calls >= 4 ? "VERDICT: APPROVED" : `worker output ${calls}` };
      },
      appendChannelMessage: (_groupId, text) => channelMessages.push(text),
    });

    await manager.start("room", "Ship the demo");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("completed"), { timeout: 5_000 });
    const run = manager.latest("room")!;
    expect(run.tasks.filter((task) => task.id !== "planning")).toHaveLength(4);
    expect(run.tasks.every((task) => task.threadId)).toBe(true);
    expect(run.tasks.at(-1)?.role).toBe("reviewer");
    expect(channelMessages.at(-1)).toBe("The project is implemented and verified.");
    expect(run.synthesisUsage).toEqual({ input: 20, output: 10 });
    expect(run.reviewStatus).toBe("approved");
    expect(run.report).toContain("Coordinator report — completed");
  });

  it("treats a mention as a task-assignment constraint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-mention-"));
    dirs.push(dir);
    let calls = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => bots,
      coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { title: "Verify Windows", description: "Run Windows verification", assignee: "tester", role: "tester" },
      ]) }),
      createTask: (_botId, title) => ({ threadId: title }),
      runBotTurn: async () => {
        calls += 1;
        return { text: "verified" };
      },
    });

    await manager.start("room", "@Tess verify Windows");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("completed"), { timeout: 5_000 });
    const run = manager.latest("room")!;
    expect(run.requestedBotIds).toEqual(["test"]);
    expect(run.tasks.find((task) => task.id !== "planning")?.botId).toBe("test");
  });

  it("uses the configured backup and blocks instead of inventing a fallback DAG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-fallback-"));
    dirs.push(dir);
    const attempted: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => bots,
      coordinatorPolicy: () => ({ ...policy(), backup: { instanceId: "backup", model: "backup-planner" }, failureMode: "fallback" }),
      runCoordinatorTurn: async ({ selection }) => {
        attempted.push(selection.instanceId);
        if (selection.instanceId === "coordinator") throw new Error("primary unavailable");
        return { text: "not valid JSON" };
      },
      createTask: () => ({ threadId: "should-not-run" }),
      runBotTurn: async () => ({ text: "should not run" }),
    });

    await manager.start("room", "Plan safely");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("planning_blocked"));
    const run = manager.latest("room")!;
    expect(attempted).toEqual(["coordinator", "backup"]);
    expect(run.tasks).toEqual([]);
    expect(run.planRevisions.map((revision) => revision.model.instanceId)).toEqual(["coordinator", "backup"]);
    expect(run.error).toBeTruthy();
  });

  it("turns reviewer rejection into an automatic fix, test, and re-review chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-fix-"));
    dirs.push(dir);
    let calls = 0;
    let threads = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => bots,
      coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { title: "Design", description: "Design", assignee: "architect" },
        { title: "Build", description: "Build", assignee: "developer", dependsOn: ["Design"] },
        { title: "Test", description: "Test", assignee: "tester", dependsOn: ["Build"] },
        { title: "Review", description: "Review", assignee: "reviewer", dependsOn: ["Test"] },
      ]) }),
      createTask: () => ({ threadId: `thread-${++threads}` }),
      runBotTurn: async () => {
        calls += 1;
        if (calls === 4) return { text: "Missing edge-case coverage\nVERDICT: CHANGES_REQUESTED" };
        if (calls >= 7) return { text: "VERDICT: APPROVED" };
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
      coordinatorPolicy: policy,
      runCoordinatorTurn: async () => {
        calls += 1;
        await planningGate;
        return { text: JSON.stringify([
          { title: "Design", description: "Design", assignee: "architect" },
          { title: "Build", description: "Build", assignee: "developer", dependsOn: ["Design"] },
          { title: "Test", description: "Test", assignee: "tester", dependsOn: ["Build"] },
          { title: "Review", description: "Review", assignee: "reviewer", dependsOn: ["Test"] },
        ]) };
      },
      createTask: (_botId, title) => ({ threadId: title }),
      runBotTurn: async () => {
        calls += 1;
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
