import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assignCoordinationRoles,
  buildCoordinationReport,
  buildCoordinationAnswer,
  CoordinationManager,
  fallbackPlan,
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
  it("plans and executes using the Channel's specialist profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "channel-profiles-")); dirs.push(dir);
    const crew: CoordinationBot[] = [
      { id: "research", name: "Rin", title: "Researcher", description: "Collect published evidence. " + "Evidence context. ".repeat(40) + "Preserve uncertainty.", model: "m" },
      { id: "critic", name: "Cam", title: "Critic", description: "Challenge assumptions and evidence quality.", model: "m" },
    ];
    const prompts: string[] = [];
    let planning = "";
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => crew, coordinatorPolicy: policy,
      runCoordinatorTurn: async ({ prompt }) => {
        planning = prompt;
        return { text: JSON.stringify([
          { title: "Find evidence", description: "Assess published evidence", role: "Researcher", botId: "research" },
          { title: "Assess findings", description: "Challenge assumptions and summarize the conclusion", role: "Critic", botId: "critic", dependsOn: ["Find evidence"] },
        ]) };
      },
      createTask: (id) => ({ threadId: id }),
      runBotTurn: async ({ prompt }) => { prompts.push(prompt); return { text: "Evidence supports a limited feasibility conclusion." }; },
    });
    const run = await manager.start("room", "Evaluate VLM feasibility");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(planning).toContain('"title":"Researcher"');
    expect(planning).toContain("Preserve uncertainty.");
    expect(run.tasks.map((task) => [task.role, task.botId])).toEqual([["Researcher", "research"], ["Critic", "critic"]]);
    expect(prompts[0]).toContain("Collect published evidence.");
    expect(prompts[1]).toContain("Challenge assumptions and evidence quality.");
    expect(prompts.join("\n")).not.toContain("Own architecture and decomposition");
    expect(prompts.join("\n")).toContain("Execution intent: follow the assigned task description");
    expect(prompts.join("\n")).not.toContain("This is an analysis/answer task");
    expect(run.reviewStatus).toBe("not_required");
  });

  it("uses a neutral fallback instead of inferring execution intent from goal keywords", () => {
    expect(fallbackPlan("Investigate architecture feasibility").tasks).toEqual([
      expect.objectContaining({ id: "complete", title: "Complete the request", description: "Investigate architecture feasibility" }),
    ]);
    expect(fallbackPlan("Create and render a launch video").tasks).toEqual([
      expect.objectContaining({ id: "complete", title: "Complete the request", description: "Create and render a launch video" }),
    ]);
  });

  it.each([
    "Evaluate VLM feasibility",
    "Implement a video pipeline",
  ])("does not invent a fixed correction pipeline for %s", async (goal) => {
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
    expect(run.fixCycles).toBe(0);
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

  it("reads completed results and adds validated follow-up work before answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-result-decisions-")); dirs.push(dir);
    const workerPrompts: string[] = [];
    let decisionCalls = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true, synthesize: true,
      runCoordinatorTurn: async ({ purpose, prompt }) => {
        if (purpose === "synthesis") return { text: "The investigation and targeted verification are complete." };
        if (purpose === "decision") {
          decisionCalls += 1;
          expect(prompt).toContain(decisionCalls === 1 ? "Initial finding" : "Follow-up verification");
          return decisionCalls === 1
            ? { text: JSON.stringify({ action: "replan", rationale: "The finding needs targeted verification", tasks: [
              { title: "Verify finding", description: "Check the discovered condition", role: "tester", botId: "test", dependsOn: ["Inspect"] },
            ] }) }
            : { text: JSON.stringify({ action: "complete", rationale: "The evidence now answers the goal" }) };
        }
        return { text: JSON.stringify([
          { id: "inspect", title: "Inspect", description: "Investigate the condition", role: "architect", botId: "arch" },
        ]) };
      },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ prompt }) => {
        workerPrompts.push(prompt);
        return { text: workerPrompts.length === 1 ? "Initial finding" : "Follow-up verification" };
      },
    });
    const run = await manager.start("room", "Investigate and answer");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(decisionCalls).toBe(2);
    expect(run.decisions?.map((decision) => decision.action)).toEqual(["replan", "complete"]);
    expect(run.tasks.map((task) => task.title)).toEqual(["Inspect", "Verify finding"]);
    expect(workerPrompts[1]).toContain("Initial finding");
    expect(run.answer).toBe("The investigation and targeted verification are complete.");
  });

  it("delivers completed Bot results when final synthesis fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-answer-fallback-")); dirs.push(dir);
    const delivered: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy, synthesize: true,
      runCoordinatorTurn: async ({ purpose }) => {
        if (purpose === "synthesis") throw new Error("summarizer unavailable");
        return { text: JSON.stringify([
          { title: "Inspect", description: "Inspect alpha", role: "architect", botId: "arch" },
          { title: "Verify", description: "Verify beta", role: "tester", botId: "test" },
        ]) };
      },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ threadId }) => ({ text: `${threadId} result` }),
      appendChannelMessage: (_group, text) => delivered.push(text),
    });
    const run = await manager.start("room", "Inspect both areas");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(run.synthesisError).toContain("summarizer unavailable");
    expect(run.answer).toContain("Inspect result");
    expect(run.answer).toContain("Verify result");
    expect(delivered.at(-1)).toBe(run.answer);
    expect(delivered.at(-1)).not.toContain("summary is unavailable");
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

  it("uses a Coordinator replan to route reviewer findings to the right Channel Bots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-coordination-fix-"));
    dirs.push(dir);
    const crew: CoordinationBot[] = [
      { id: "director", name: "Director", title: "Video Director", description: "Own narrative and storyboard", model: "m" },
      { id: "motion", name: "Motion", title: "Motion Designer", description: "Build and render scenes", model: "m" },
      { id: "copy", name: "Copy", title: "Copywriter", description: "Write narration and titles", model: "m" },
      { id: "critic", name: "Critic", title: "Critic", description: "Final acceptance reviewer", model: "m" },
    ];
    let decisionCalls = 0;
    let threads = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"),
      groupBots: () => crew,
      coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose, prompt }) => {
        if (purpose === "decision") {
          decisionCalls += 1;
          const context = JSON.parse(prompt);
          if (decisionCalls === 1) {
            expect(context.trigger).toBe("review_rejected");
            return { text: JSON.stringify({ action: "replan", rationale: "The narration caused the rejected frames", tasks: [
              { title: "Revise narration", description: "Correct the narration called out by the Critic", role: "Copywriter", botId: "copy", dependsOn: ["Initial acceptance"] },
              { title: "Re-render", description: "Render the corrected deliverable", role: "Motion Designer", botId: "motion", dependsOn: ["Revise narration"] },
              { title: "Re-review", description: "Review the corrected deliverable", role: "reviewer", botId: "critic", dependsOn: ["Re-render"] },
            ] }) };
          }
          expect(context.trigger).toBe("result_gap");
          return { text: JSON.stringify({ action: "complete", rationale: "The corrected deliverable is approved" }) };
        }
        return { text: JSON.stringify([
          { title: "Storyboard", description: "Create the storyboard", role: "Video Director", botId: "director" },
          { title: "Narration", description: "Write the narration", role: "Copywriter", botId: "copy" },
          { title: "Render", description: "Render the deliverable", role: "Motion Designer", botId: "motion", dependsOn: ["Storyboard", "Narration"] },
          { title: "Initial acceptance", description: "Review the initial deliverable", role: "reviewer", botId: "critic", dependsOn: ["Render"] },
        ]) };
      },
      createTask: () => ({ threadId: `thread-${++threads}` }),
      runBotTurn: async ({ prompt }) => {
        if (prompt.includes("Review the initial deliverable")) return { text: "The narration does not match the frames.\nVERDICT: CHANGES_REQUESTED" };
        if (prompt.includes("Review the corrected deliverable")) return { text: "VERDICT: APPROVED" };
        return { text: "worker output" };
      },
    });

    await manager.start("room", "Create a deliverable with the whole Channel");
    await vi.waitFor(() => expect(manager.latest("room")?.status).toBe("completed"), { timeout: 5_000 });
    const run = manager.latest("room")!;
    expect(run.fixCycles).toBe(1);
    expect(run.tasks).toHaveLength(7);
    expect(run.tasks.slice(-3).map((task) => task.botId)).toEqual(["copy", "motion", "critic"]);
    expect(run.tasks.slice(-3).map((task) => task.planRevision)).toEqual([2, 2, 2]);
    expect(run.tasks.slice(-3).map((task) => task.replanTrigger)).toEqual(["review_rejected", "review_rejected", "review_rejected"]);
    expect(run.decisions?.map((decision) => decision.action)).toEqual(["replan", "complete"]);
    expect(run.reviewStatus).toBe("approved");
    expect(run.tasks.some((task) => task.title.startsWith("Fix reviewer findings"))).toBe(false);
  });

  it("does not let Coordinator complete while the latest reviewer rejects the deliverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-review-invariant-"));
    dirs.push(dir);
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose }) => purpose === "decision"
        ? { text: JSON.stringify({ action: "complete", rationale: "Ignore the review" }) }
        : { text: JSON.stringify([
          { title: "Work", description: "Produce the requested result", role: "developer", botId: "dev" },
          { title: "Acceptance", description: "Review the result", role: "reviewer", botId: "review", dependsOn: ["Work"] },
        ]) },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ prompt }) => ({ text: prompt.includes("Review the result") ? "VERDICT: CHANGES_REQUESTED" : "result" }),
    });

    const run = await manager.start("room", "Complete work with acceptance");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(run.decisions).toEqual([
      expect.objectContaining({ action: "complete", accepted: false, rejectionReason: "Unresolved review findings remain" }),
    ]);
    expect(run.reviewStatus).toBe("changes_requested");
    expect(run.events.some((event) => event.message.includes("completion rejected"))).toBe(true);
  });

  it("finishes as failed with the Coordinator's reason when safe progress is blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-replan-blocked-"));
    dirs.push(dir);
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose }) => purpose === "decision"
        ? { text: JSON.stringify({ action: "blocked", rationale: "Required authority is unavailable", needsUser: true }) }
        : { text: JSON.stringify([{ title: "Inspect", description: "Inspect the request", role: "architect", botId: "arch" }]) },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async () => ({ text: "The missing authority prevents completion." }),
    });

    const run = await manager.start("room", "Complete work requiring external authority");
    await vi.waitFor(() => expect(run.status).toBe("failed"));
    expect(run.error).toBe("Required authority is unavailable");
    expect(run.decisions?.at(-1)).toEqual(expect.objectContaining({ action: "blocked", needsUser: true }));
  });

  it("rejects a review-triggered replan without one terminal reviewer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-replan-review-gate-"));
    dirs.push(dir);
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose }) => purpose === "decision"
        ? { text: JSON.stringify({ action: "replan", rationale: "Apply a correction", tasks: [
          { title: "Correction", description: "Correct the result", role: "developer", botId: "dev", dependsOn: ["Acceptance"] },
        ] }) }
        : { text: JSON.stringify([
          { title: "Work", description: "Produce the result", role: "developer", botId: "dev" },
          { title: "Acceptance", description: "Review the result", role: "reviewer", botId: "review", dependsOn: ["Work"] },
        ]) },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ prompt }) => ({ text: prompt.includes("Review the result") ? "VERDICT: CHANGES_REQUESTED" : "result" }),
    });

    const run = await manager.start("room", "Complete work with acceptance");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(run.tasks.map((task) => task.title)).toEqual(["Work", "Acceptance"]);
    expect(run.decisions).toEqual([
      expect.objectContaining({ action: "replan", accepted: false, rejectionReason: "A review-rejected replan must end in one terminal reviewer task" }),
    ]);
    expect(run.events.some((event) => event.message.includes("must end in one terminal reviewer"))).toBe(true);
  });

  it("stops review-triggered replans at the Runtime-owned limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-replan-limit-"));
    dirs.push(dir);
    let decisionCalls = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots,
      coordinatorPolicy: () => ({ ...policy(), maxFixCycles: 1 }),
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose }) => {
        if (purpose !== "decision") return { text: JSON.stringify([
          { title: "Work", description: "Produce the result", role: "developer", botId: "dev" },
          { title: "Acceptance", description: "Review the result", role: "reviewer", botId: "review", dependsOn: ["Work"] },
        ]) };
        decisionCalls += 1;
        return { text: JSON.stringify({ action: "replan", rationale: "Correct and review once", tasks: [
          { title: "Correction", description: "Correct the rejected result", role: "developer", botId: "dev", dependsOn: ["Acceptance"] },
          { title: "Re-review", description: "Review the correction", role: "reviewer", botId: "review", dependsOn: ["Correction"] },
        ] }) };
      },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ prompt }) => ({ text: prompt.includes("Review") ? "VERDICT: CHANGES_REQUESTED" : "result" }),
    });

    const run = await manager.start("room", "Complete work with bounded acceptance");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(decisionCalls).toBe(1);
    expect(run.fixCycles).toBe(1);
    expect(run.tasks).toHaveLength(4);
    expect(run.reviewStatus).toBe("changes_requested");
    expect(run.events.some((event) => event.message.includes("unresolved after 1 replans"))).toBe(true);
  });

  it("stops an identical result-gap replan from looping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-replan-loop-"));
    dirs.push(dir);
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose }) => purpose === "decision"
        ? { text: JSON.stringify({ action: "replan", rationale: "Verify once more", tasks: [
          { title: "Verify finding", description: "Verify the same finding", role: "tester", botId: "test", dependsOn: ["Inspect"] },
        ] }) }
        : { text: JSON.stringify([
          { title: "Inspect", description: "Inspect the request", role: "architect", botId: "arch" },
        ]) },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async () => ({ text: "evidence" }),
    });

    const run = await manager.start("room", "Inspect and verify");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(run.tasks.map((task) => task.title)).toEqual(["Inspect", "Verify finding"]);
    expect(run.decisions?.map((decision) => [decision.action, decision.accepted])).toEqual([["replan", true], ["replan", false]]);
    expect(run.events.some((event) => event.message.includes("repeated an earlier replan"))).toBe(true);
  });

  it("recovers failed work only after a declared replacement revision succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-failure-replan-"));
    dirs.push(dir);
    let decisionCalls = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose, prompt }) => {
        if (purpose !== "decision") return { text: JSON.stringify([
          { id: "work", title: "Work", description: "Fail once", role: "developer", botId: "dev" },
        ]) };
        decisionCalls += 1;
        const context = JSON.parse(prompt);
        if (decisionCalls === 1) {
          expect(context.trigger).toBe("task_failed");
          return { text: JSON.stringify({ action: "replan", rationale: "Use a fresh replacement task", resolvesTaskIds: ["work"], tasks: [
            { title: "Replacement", description: "Complete the failed deliverable with a fresh approach", role: "developer", botId: "dev" },
          ] }) };
        }
        expect(context.trigger).toBe("result_gap");
        return { text: JSON.stringify({ action: "complete", rationale: "The replacement succeeded" }) };
      },
      createTask: (_bot, title) => ({ threadId: title }),
      runBotTurn: async ({ prompt }) => {
        if (prompt.includes("Fail once")) throw new Error("provider failed");
        return { text: "replacement result" };
      },
    });

    const run = await manager.start("room", "Complete recoverable work");
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(run.tasks).toHaveLength(2);
    expect(run.tasks[0]).toEqual(expect.objectContaining({ status: "failed", resolvedByPlanRevision: 2 }));
    expect(run.tasks[1]).toEqual(expect.objectContaining({ status: "completed", planRevision: 2, replanTrigger: "task_failed" }));
    expect(run.decisions?.map((decision) => decision.action)).toEqual(["replan", "complete"]);
    expect(buildCoordinationReport(run)).toContain("recovered by replan 2");
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

  it("persists active-run steering and applies it through a directed plan revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-steering-"));
    dirs.push(dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const decisionPrompts: string[] = [];
    let workerCalls = 0;
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true,
      runCoordinatorTurn: async ({ purpose, prompt }) => {
        if (purpose !== "decision") return { text: JSON.stringify([
          { id: "draft", title: "Draft", description: "Create the initial deliverable", role: "developer", botId: "dev" },
        ]) };
        decisionPrompts.push(prompt);
        return decisionPrompts.length === 1
          ? { text: JSON.stringify({ action: "replan", rationale: "Apply the requested blue treatment", tasks: [
            { id: "revise", title: "Revise color treatment", description: "Update the deliverable to blue", role: "developer", botId: "dev", dependsOn: ["draft"] },
          ] }) }
          : { text: JSON.stringify({ action: "complete", rationale: "The steered deliverable is complete" }) };
      },
      createTask: (_botId, title) => ({ threadId: title }),
      runBotTurn: async () => {
        workerCalls += 1;
        if (workerCalls === 1) await gate;
        return { text: workerCalls === 1 ? "Initial draft" : "Blue revision" };
      },
    });

    const run = await manager.start("room", "Create a launch asset");
    await vi.waitFor(() => expect(run.tasks[0]?.status).toBe("running"));
    manager.steer("room", "Use blue instead of green", "message-1");
    expect(run.steerings?.[0]).toEqual(expect.objectContaining({ status: "pending", messageId: "message-1" }));
    release();
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(JSON.parse(decisionPrompts[0]!).trigger).toBe("user_steering");
    expect(decisionPrompts[0]).toContain("Use blue instead of green");
    expect(run.steerings?.[0]).toEqual(expect.objectContaining({ status: "applied", appliedPlanRevision: 2 }));
    expect(run.tasks.at(-1)).toEqual(expect.objectContaining({ status: "completed", replanTrigger: "user_steering", planRevision: 2 }));
  });

  it("resumes an interrupted persisted task in the same Run and Channel session", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "roundtable-restart-source-"));
    const recoveredDir = mkdtempSync(join(tmpdir(), "roundtable-restart-recovered-"));
    dirs.push(sourceDir, recoveredDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = new CoordinationManager({
      file: join(sourceDir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { id: "build", title: "Build", description: "Create the artifact", role: "developer", botId: "dev" },
      ]) }),
      createTask: () => ({ threadId: "channel-dev-session" }),
      runBotTurn: async () => { await gate; return { text: "old process" }; },
    });
    const original = await first.start("room", "Create a durable artifact");
    await vi.waitFor(() => expect(original.tasks[0]?.status).toBe("running"));
    copyFileSync(join(sourceDir, "runs.json"), join(recoveredDir, "runs.json"));

    const calls: Array<{ threadId: string; prompt: string }> = [];
    const recovered = new CoordinationManager({
      file: join(recoveredDir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: "unused" }),
      createTask: () => { throw new Error("must reuse the persisted Channel session"); },
      runBotTurn: async ({ threadId, prompt }) => { calls.push({ threadId, prompt }); return { text: "recovered result" }; },
    });
    const loaded = recovered.latest("room")!;
    expect(loaded.status).toBe("running");
    expect(loaded.tasks[0]).toEqual(expect.objectContaining({ status: "ready", threadId: "channel-dev-session", attempt: 2 }));
    expect(loaded.recovery?.interruptedTaskIds).toEqual(["build"]);
    expect(recovered.resumePersistedRuns()).toEqual([loaded]);
    await vi.waitFor(() => expect(loaded.status).toBe("completed"));
    expect(calls[0]?.threadId).toBe("channel-dev-session");
    expect(calls[0]?.prompt).toContain("inspect current workspace and external state first");
    expect(loaded.tasks[0]?.output).toBe("recovered result");
    release();
    await vi.waitFor(() => expect(original.status).toBe("completed"));
  });

  it("keeps a persisted paused Run frozen until the user resumes it", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "roundtable-paused-source-"));
    const recoveredDir = mkdtempSync(join(tmpdir(), "roundtable-paused-recovered-"));
    dirs.push(sourceDir, recoveredDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = new CoordinationManager({
      file: join(sourceDir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: JSON.stringify([
        { id: "build", title: "Build", description: "Create the artifact", role: "developer", botId: "dev" },
      ]) }),
      createTask: () => ({ threadId: "paused-channel-session" }),
      runBotTurn: async () => { await gate; return { text: "old process" }; },
    });
    const original = await first.start("room", "Create an artifact, then pause");
    await vi.waitFor(() => expect(original.tasks[0]?.status).toBe("running"));
    first.pause("room");
    copyFileSync(join(sourceDir, "runs.json"), join(recoveredDir, "runs.json"));

    let recoveredCalls = 0;
    const recovered = new CoordinationManager({
      file: join(recoveredDir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      runCoordinatorTurn: async () => ({ text: "unused" }),
      createTask: () => { throw new Error("must reuse the persisted session"); },
      runBotTurn: async () => { recoveredCalls += 1; return { text: "resumed result" }; },
    });
    const loaded = recovered.latest("room")!;
    expect(loaded.status).toBe("paused");
    recovered.resumePersistedRuns();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(loaded.status).toBe("paused");
    expect(recoveredCalls).toBe(0);
    recovered.resume("room");
    await vi.waitFor(() => expect(loaded.status).toBe("completed"));
    expect(recoveredCalls).toBe(1);
    await first.cancel("room");
    release();
  });

  it("does not let final synthesis race past newly arrived steering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roundtable-steering-synthesis-"));
    dirs.push(dir);
    let releaseSynthesis!: () => void;
    const synthesisGate = new Promise<void>((resolve) => { releaseSynthesis = resolve; });
    let synthesisCalls = 0;
    let decisionCalls = 0;
    const delivered: string[] = [];
    const manager = new CoordinationManager({
      file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
      decideAfterResults: true, synthesize: true,
      runCoordinatorTurn: async ({ purpose }) => {
        if (purpose === "synthesis") {
          synthesisCalls += 1;
          if (synthesisCalls === 1) await synthesisGate;
          return { text: synthesisCalls === 1 ? "stale answer" : "answer with steering" };
        }
        if (purpose === "decision") {
          decisionCalls += 1;
          if (decisionCalls === 2) return { text: JSON.stringify({ action: "replan", rationale: "Apply steering", tasks: [
            { id: "update", title: "Update", description: "Apply the new direction", role: "developer", botId: "dev", dependsOn: ["draft"] },
          ] }) };
          return { text: JSON.stringify({ action: "complete", rationale: "Evidence is sufficient" }) };
        }
        return { text: JSON.stringify([
          { id: "draft", title: "Draft", description: "Create the draft", role: "developer", botId: "dev" },
        ]) };
      },
      createTask: (_botId, title) => ({ threadId: title }),
      runBotTurn: async () => ({ text: "worker result" }),
      appendChannelMessage: (_groupId, text) => delivered.push(text),
    });
    const run = await manager.start("room", "Create an artifact");
    await vi.waitFor(() => expect(synthesisCalls).toBe(1));
    manager.steer("room", "Add the late requirement", "late-message");
    releaseSynthesis();
    await vi.waitFor(() => expect(run.status).toBe("completed"));
    expect(synthesisCalls).toBe(2);
    expect(run.answer).toBe("answer with steering");
    expect(delivered).toEqual([expect.stringContaining("answer with steering")]);
    expect(delivered[0]).not.toContain("stale answer");
  });
});
