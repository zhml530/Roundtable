import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinationManager, type CoordinationManagerOptions, type CoordinationRun } from "./coordination.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bots = [
  { id: "atlas", name: "Atlas", title: "Generalist", description: "Handles bounded requests", model: "m" },
  { id: "review", name: "Reviewer", title: "Reviewer", description: "Reviews evidence", model: "m" },
];
const dispatch = {
  action: "dispatch", botId: "atlas", title: "Answer the request", description: "Answer the user directly",
  state: "conversation", risk: "low", requiresReview: false,
};
const plan = { action: "plan", tasks: [{ id: "next", title: "Remaining work", description: "Use existing evidence", botId: "atlas" }] };
const policy = () => ({
  primary: { instanceId: "coordinator", model: "m" }, failureMode: "pause" as const,
  planningTimeoutMs: 1000, planningRetries: 0, maxConcurrency: 2, maxFixCycles: 2,
  maxRunMinutes: 5, requireHighRiskReview: true,
});
function fixture(overrides: Partial<CoordinationManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "adaptive-coordination-")); dirs.push(dir);
  const coordinator = vi.fn<CoordinationManagerOptions["runCoordinatorTurn"]>(async () => ({ text: JSON.stringify(dispatch) }));
  const worker = vi.fn<CoordinationManagerOptions["runBotTurn"]>(async () => ({ text: "Hello from Atlas." }));
  const append = vi.fn();
  const saveState = vi.fn(() => ({ bytes: 10 }));
  const options: CoordinationManagerOptions = {
    file: join(dir, "runs.json"), groupBots: () => bots, coordinatorPolicy: policy,
    createTask: () => ({ threadId: "channel-worker" }), runBotTurn: worker,
    runCoordinatorTurn: coordinator, appendChannelMessage: append,
    synthesize: true, decideAfterResults: true, saveProjectState: saveState,
    ...overrides,
  };
  return { manager: new CoordinationManager(options), options, coordinator, worker, append, saveState };
}
async function settled(run: CoordinationRun) {
  await vi.waitFor(() => expect(["completed", "failed", "planning_blocked", "cancelled"]).toContain(run.status));
}

describe("adaptive Coordinator", () => {
  const escalation = { reason: "A dependency needs a specialist", evidence: "Draft already saved at draft.txt",
    completedActions: ["Saved draft.txt"], remainingWork: "Check the missing dependency" };

  it("accepts only a scoped structured handoff and carries completed evidence into remaining work", async () => {
    const calls: Array<{ purpose?: string; prompt: string }> = [];
    const f = fixture({
      runCoordinatorTurn: async (input) => {
        calls.push(input);
        return { text: input.purpose === "routing" ? JSON.stringify(dispatch)
          : input.purpose === "planning" ? JSON.stringify(plan)
            : input.purpose === "decision" ? '{"action":"complete","rationale":"Finished remaining work"}'
              : input.purpose === "checkpoint" ? "# Project\nDraft and dependency resolved" : "Resolved dependency." };
      },
      runBotTurn: async ({ botId, threadId, prompt }) => {
        const run = f.manager.latest("channel")!;
        if (run.executionMode === "direct") {
          expect(() => f.manager.requestPlanning(run.id, "direct", "review", threadId, escalation)).toThrow(/active direct/);
          expect(() => f.manager.requestPlanning(run.id, "direct", botId, "another-topic", escalation)).toThrow(/active direct/);
          expect(() => f.manager.requestPlanning(run.id, "direct", botId, threadId, JSON.parse('{"reason":"missing evidence"}'))).toThrow();
          f.manager.requestPlanning(run.id, "direct", botId, threadId, escalation);
          f.manager.requestPlanning(run.id, "direct", botId, threadId, escalation);
          expect(() => f.manager.requestPlanning(run.id, "direct", botId, threadId, { ...escalation, reason: "overwrite" })).toThrow(/already persisted/);
          expect(JSON.parse(readFileSync(f.options.file!, "utf8")).runs[0].dispatch.escalation).toEqual(escalation);
          return { text: "" };
        }
        expect(prompt).toContain("Saved draft.txt");
        expect(prompt).toContain("Do not repeat");
        return { text: "Resolved dependency." };
      },
    });
    const run = await f.manager.start("channel", "Complete one draft");
    await settled(run);
    expect(run.status).toBe("completed");
    expect(run.executionMode).toBe("planned");
    expect(run.tasks).toHaveLength(2);
    expect(run.tasks[0]).toMatchObject({ id: "direct", status: "completed", output: "" });
    expect(calls.map((call) => call.purpose)).toEqual(["routing", "planning", "decision", "synthesis", "checkpoint"]);
    expect(calls[1].prompt).toContain("Saved draft.txt");
    expect(() => f.manager.requestPlanning(run.id, "direct", "atlas", "channel-worker", escalation)).toThrow(/active direct/);
  });

  it("rejects a continuation that repeats a completed irreversible action", async () => {
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => ({ text: JSON.stringify(purpose === "routing" ? dispatch : {
        action: "plan", tasks: [{ title: "Saved draft.txt", description: "Repeat this action", botId: "atlas" }],
      }) }),
      runBotTurn: async ({ botId, threadId }) => {
        f.manager.requestPlanning(f.manager.latest("channel")!.id, "direct", botId, threadId, escalation);
        return { text: "Saved draft.txt" };
      },
    });
    const run = await f.manager.start("channel", "Prepare a draft");
    await settled(run);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("repeat completed work");
    expect(run.tasks).toHaveLength(1);
  });

  it("does not deliver a late direct result after cancellation", async () => {
    let finish!: (value: { text: string }) => void;
    const f = fixture({ runBotTurn: () => new Promise((resolve) => { finish = resolve; }) });
    const run = await f.manager.start("channel", "Hi");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.manager.cancel("channel");
    finish({ text: "Late answer" });
    await vi.waitFor(() => expect(run.tasks[0].output).toBe("Late answer"));
    expect(run.status).toBe("cancelled");
    expect(run.tasks[0].status).toBe("cancelled");
    expect(f.append.mock.calls.some((call) => call[1] === "Late answer")).toBe(false);
    expect(f.coordinator).toHaveBeenCalledTimes(1);
  });

  it("keeps a paused direct result pending until resume", async () => {
    let finish!: (value: { text: string }) => void;
    const f = fixture({ runBotTurn: () => new Promise((resolve) => { finish = resolve; }) });
    const run = await f.manager.start("channel", "Hi");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.manager.pause("channel");
    finish({ text: "Hello" });
    await vi.waitFor(() => expect(run.tasks[0].status).toBe("completed"));
    expect(run.status).toBe("paused");
    expect(f.append).not.toHaveBeenCalled();
    f.manager.resume("channel");
    await settled(run);
    expect(run.status).toBe("completed");
  });

  it("does not execute a queued direct assignment superseded by steering", async () => {
    let releaseFirst!: (value: { text: string }) => void;
    const prompts: string[] = [];
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => ({ text: purpose === "routing" ? JSON.stringify(dispatch)
        : purpose === "planning" ? JSON.stringify(plan)
          : purpose === "decision" ? '{"action":"complete","rationale":"Done"}'
            : purpose === "checkpoint" ? "# Project\nDone" : "Updated answer" }),
      runBotTurn: ({ prompt }) => {
        prompts.push(prompt);
        return prompts.length === 1 ? new Promise((resolve) => { releaseFirst = resolve; }) : Promise.resolve({ text: "Updated answer" });
      },
    });
    const first = await f.manager.start("first", "Hi");
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    const second = await f.manager.start("second", "Answer my request");
    await vi.waitFor(() => expect(second.tasks[0]?.status).toBe("running"));
    f.manager.steer("second", "Instead investigate the missing dependency");
    releaseFirst({ text: "Hello" });
    await settled(first);
    await settled(second);
    expect(second.status).toBe("completed");
    expect(second.executionMode).toBe("planned");
    expect(second.tasks[0].status).toBe("cancelled");
    expect(prompts).toHaveLength(2);
  });

  it("settles steering arriving during the direct checkpoint before declaring completion", async () => {
    let checkpoint!: (value: { text: string }) => void;
    let checkpointCalls = 0;
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => {
        if (purpose === "checkpoint" && ++checkpointCalls === 1) return new Promise((resolve) => { checkpoint = resolve; });
        return { text: purpose === "routing" ? JSON.stringify({ ...dispatch, state: "project" })
          : purpose === "planning" ? JSON.stringify(plan)
            : purpose === "decision" ? '{"action":"complete","rationale":"Done"}'
              : purpose === "checkpoint" ? "# Project\nFinal" : "Final answer" };
      },
    });
    const run = await f.manager.start("channel", "Prepare a draft");
    await vi.waitFor(() => expect(checkpoint).toBeTypeOf("function"));
    f.manager.steer("channel", "Also check a dependency");
    checkpoint({ text: "# Project\nStale" });
    await settled(run);
    expect(run.status).toBe("completed");
    expect(run.executionMode).toBe("planned");
    expect(run.steerings?.[0].status).toBe("applied");
    expect(f.saveState).toHaveBeenCalledTimes(1);
    expect(f.saveState.mock.calls[0]).toContain("# Project\nFinal");
  });

  it("answers a greeting with exactly one routing call and one worker, not a DAG or checkpoint", async () => {
    const f = fixture();
    const run = await f.manager.start("channel", "Hi");
    await settled(run);
    expect(run.status).toBe("completed");
    expect(run.executionMode).toBe("direct");
    expect(f.coordinator).toHaveBeenCalledTimes(1);
    expect(f.coordinator.mock.calls[0][0].purpose).toBe("routing");
    expect(f.worker).toHaveBeenCalledTimes(1);
    expect(f.saveState).not.toHaveBeenCalled();
    expect(run.answer).toBe("Hello from Atlas.");
    expect(f.append.mock.calls.at(-1)?.[1]).toBe("Hello from Atlas.");
    expect(run.events.some((event) => /DAG ready|evaluating completed|Preparing the Channel answer|Updating the durable/.test(event.message))).toBe(false);
  });

  it.each([
    ["unknown bot", { botId: "missing" }, "Hi"],
    ["wrong requested bot", {}, "@Reviewer please answer"],
    ["multiple requested bots", {}, "@Atlas @Reviewer help"],
    ["all requested bots", {}, "@everyone help"],
    ["high risk", {}, "deploy to production"],
    ["required review", {}, "Implement and request a review"],
    ["non-low risk", { risk: "high" }, "Hi"],
    ["review required", { requiresReview: true }, "Hi"],
    ["dependencies in direct mode", { dependsOn: ["something"] }, "Hi"],
    ["unknown outcome", { action: "execute" }, "Hi"],
    ["missing state policy", { state: undefined }, "Hi"],
  ])("rejects unsafe dispatch: %s", async (_name, patch, goal) => {
    const f = fixture({ runCoordinatorTurn: async () => ({ text: JSON.stringify({ ...dispatch, ...patch }) }) });
    const run = await f.manager.start("channel", goal);
    await settled(run);
    expect(run.status).toBe("planning_blocked");
    expect(f.worker).not.toHaveBeenCalled();
    expect(run.error).toBeTruthy();
  });

  it("does not infer complexity from request length or roster size", async () => {
    const f = fixture();
    const run = await f.manager.start("channel", `Summarize this paragraph: ${"A bounded passage. ".repeat(90)}`);
    await settled(run);
    expect(run.executionMode).toBe("direct");
    expect(f.worker).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("checkpoints state-bearing direct work (tool use: %s) without decisions or synthesis", async (usedTools) => {
    const purposes: Array<string | undefined> = [];
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => {
        purposes.push(purpose);
        return { text: purpose === "checkpoint" ? "# Project\nUpdated" : JSON.stringify({ ...dispatch, state: usedTools ? "conversation" : "project" }),
          usage: { input: 10, output: 5 } };
      },
      runBotTurn: async () => ({ text: "Updated the requested file.", usedTools }),
    });
    const run = await f.manager.start("channel", "Update one local document");
    await settled(run);
    expect(run.status).toBe("completed");
    expect(purposes).toEqual(["routing", "checkpoint"]);
    expect(f.saveState).toHaveBeenCalledTimes(1);
    expect(run.answer).toBe("Updated the requested file.");
    expect(run.report).toContain("30 Coordinator tokens");
  });

  it.each(["", "   "])("does not call an empty worker output a success", async (text) => {
    const f = fixture({ runBotTurn: async () => ({ text }) });
    const run = await f.manager.start("channel", "Hi");
    await settled(run);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/empty|no.*answer/i);
    expect(f.coordinator).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit worker failure without routine evaluation", async () => {
    const f = fixture({ runBotTurn: async () => { throw new Error("Provider failed"); } });
    const run = await f.manager.start("channel", "Hi");
    await settled(run);
    expect(run.status).toBe("failed");
    expect(run.tasks[0].status).toBe("failed");
    expect(run.error).toContain("Provider failed");
    expect(f.coordinator).toHaveBeenCalledTimes(1);
  });

  it("does not interpret prose or JSON in the worker answer as escalation authority", async () => {
    const text = JSON.stringify({ action: "needs-planning", reason: "Quoted tool output", evidence: "not a control request", completedActions: [] });
    const f = fixture({ runBotTurn: async () => ({ text }) });
    const run = await f.manager.start("channel", "Explain this example");
    await settled(run);
    expect(run.status).toBe("completed");
    expect(run.answer).toBe(text);
    expect(f.coordinator).toHaveBeenCalledTimes(1);
  });

  it.each(["plan", "legacy"])("preserves planned execution for %s proposals", async (kind) => {
    const purposes: Array<string | undefined> = [];
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => {
        purposes.push(purpose);
        return { text: purpose === "decision" ? '{"action":"complete","rationale":"Done"}'
          : purpose === "synthesis" ? "Final planned answer"
            : purpose === "checkpoint" ? "# Project\nDone"
              : JSON.stringify(kind === "legacy" ? plan.tasks : plan) };
      },
    });
    const run = await f.manager.start("channel", "Investigate an uncertain request");
    await settled(run);
    expect(run.status).toBe("completed");
    expect(run.executionMode).toBe("planned");
    expect(purposes).toEqual(["routing", "decision", "synthesis", "checkpoint"]);
  });

  it("finalizes a persisted completed direct receipt without rerunning the worker", async () => {
    const f = fixture();
    const original = await f.manager.start("channel", "Hi");
    await settled(original);
    const envelope = JSON.parse(readFileSync(f.options.file!, "utf8"));
    envelope.runs[0].status = "running";
    delete envelope.runs[0].finishedAt;
    writeFileSync(f.options.file!, JSON.stringify(envelope));
    const restored = new CoordinationManager(f.options);
    restored.resumePersistedRuns();
    await settled(restored.latest("channel")!);
    expect(restored.latest("channel")!.status).toBe("completed");
    expect(f.worker).toHaveBeenCalledTimes(1);
    expect(f.coordinator).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "failed", "blocked", "cancelled"])("fails closed on a persisted %s dispatch rather than repeat actions", async (status) => {
    const f = fixture();
    const original = await f.manager.start("channel", "Hi");
    await settled(original);
    const envelope = JSON.parse(readFileSync(f.options.file!, "utf8"));
    envelope.runs[0].status = "running";
    envelope.runs[0].tasks[0].status = status;
    delete envelope.runs[0].tasks[0].output;
    writeFileSync(f.options.file!, JSON.stringify(envelope));
    const restored = new CoordinationManager(f.options);
    restored.resumePersistedRuns();
    await settled(restored.latest("channel")!);
    expect(restored.latest("channel")!.status).toBe("failed");
    expect(restored.latest("channel")!.error).toMatch(/unknown|interrupted|already ended/i);
    expect(f.worker).toHaveBeenCalledTimes(1);
  });

  it("resumes a persisted planning handoff without replaying its completed worker", async () => {
    const originalFixture = fixture();
    const original = await originalFixture.manager.start("channel", "Hi");
    await settled(original);
    const envelope = JSON.parse(readFileSync(originalFixture.options.file!, "utf8"));
    envelope.runs[0].status = "running";
    envelope.runs[0].dispatch.escalation = escalation;
    writeFileSync(originalFixture.options.file!, JSON.stringify(envelope));
    const turns: Array<string | undefined> = [];
    const worker = vi.fn<CoordinationManagerOptions["runBotTurn"]>(async () => ({ text: "Remaining dependency resolved" }));
    const restored = new CoordinationManager({
      ...originalFixture.options, runBotTurn: worker,
      runCoordinatorTurn: async ({ purpose, prompt }) => {
        turns.push(purpose);
        if (purpose === "planning") expect(prompt).toContain("Saved draft.txt");
        return { text: purpose === "planning" ? JSON.stringify(plan)
          : purpose === "decision" ? '{"action":"complete","rationale":"Done"}'
            : purpose === "checkpoint" ? "# Project\nDone" : "Dependency resolved" };
      },
    });
    restored.resumePersistedRuns();
    await settled(restored.latest("channel")!);
    expect(restored.latest("channel")!.status).toBe("completed");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker.mock.calls[0][0]).not.toBeUndefined();
    expect(turns[0]).toBe("planning");
    expect(turns).not.toContain("routing");
  });

  it("retains review on a worker's explicit review escalation", async () => {
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => ({ text: purpose === "routing" ? JSON.stringify(dispatch)
        : purpose === "planning" ? JSON.stringify(plan)
          : purpose === "decision" ? '{"action":"complete","rationale":"Reviewed"}'
            : purpose === "checkpoint" ? "# Project\nReviewed" : "Reviewed result" }),
      runBotTurn: async ({ botId, threadId }) => {
        const run = f.manager.latest("channel")!;
        if (run.executionMode === "direct") {
          f.manager.requestPlanning(run.id, "direct", botId, threadId, { ...escalation,
            reason: "An independent review is required", remainingWork: "Check the deliverable" });
          return { text: "Evidence saved" };
        }
        return { text: "Verified deliverable. VERDICT: APPROVED" };
      },
    });
    const run = await f.manager.start("channel", "Prepare a bounded deliverable");
    await settled(run);
    expect(run.tasks.some((task) => task.role === "reviewer")).toBe(true);
    expect(run.reviewStatus).toBe("approved");
  });

  it.each(["plan", "legacy"])("accepts the %s contract in the Settings Coordinator smoke test", async (kind) => {
    const f = fixture({ runCoordinatorTurn: async () => ({ text: JSON.stringify(kind === "plan" ? plan : plan.tasks) }) });
    expect(await f.manager.testCoordinator()).toMatchObject({ ok: true, taskCount: 1 });
  });

  it("retries failed direct finalization from its completed receipt, never the worker", async () => {
    let checkpoints = 0;
    const f = fixture({
      runCoordinatorTurn: async ({ purpose }) => {
        if (purpose === "checkpoint" && ++checkpoints === 1) throw new Error("Checkpoint unavailable");
        return { text: purpose === "checkpoint" ? "# Project\nRecord appended" : JSON.stringify({ ...dispatch, state: "project" }) };
      },
    });
    const run = await f.manager.start("channel", "Append one local record");
    await settled(run);
    expect(run.status).toBe("failed");
    expect(run.tasks[0].status).toBe("completed");
    const retried = await f.manager.retry("channel");
    await settled(retried);
    expect(retried.status).toBe("completed");
    expect(retried.id).toBe(run.id);
    expect(f.worker).toHaveBeenCalledTimes(1);
    expect(checkpoints).toBe(2);
  });

  it("does not turn retry of an uncertain direct failure into another dispatch", async () => {
    const f = fixture({ runBotTurn: async () => { throw new Error("Connection lost after an action"); } });
    const run = await f.manager.start("channel", "Append one record");
    await settled(run);
    await expect(f.manager.retry("channel")).rejects.toThrow(/inspect|remaining work/i);
  });
});
