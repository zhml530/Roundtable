import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  OpenMultiAgent,
  type LLMAdapter,
  type LLMChatOptions,
  type LLMMessage,
  type LLMResponse,
  type LLMStreamOptions,
  type OrchestratorEvent,
  type PlanArtifact,
  type PlanTaskArtifact,
  type StreamEvent,
  type TeamRunResult,
} from "@open-multi-agent/core";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export type CoordinationRole = "architect" | "developer" | "tester" | "reviewer";
export type CoordinationRunStatus = "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type CoordinationTaskStatus = "pending" | "ready" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface CoordinationBot {
  id: string;
  name: string;
  title: string;
  description: string;
  model: string;
}

export interface CoordinationTask {
  id: string;
  title: string;
  description: string;
  role: CoordinationRole;
  botId: string;
  botName: string;
  dependsOn: string[];
  status: CoordinationTaskStatus;
  threadId?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  attempt: number;
  fixCycle?: number;
}

export interface CoordinationEvent {
  id: string;
  at: number;
  type: "run" | "task" | "review" | "control";
  message: string;
  taskId?: string;
}

export interface CoordinationRun {
  id: string;
  groupId: string;
  goal: string;
  status: CoordinationRunStatus;
  roles: Record<CoordinationRole, { botId: string; botName: string }>;
  tasks: CoordinationTask[];
  events: CoordinationEvent[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  report?: string;
  fixCycles: number;
}

interface CoordinationFile {
  version: 1;
  runs: CoordinationRun[];
}

interface BotTurnResult {
  text: string;
  usage?: { input: number; output: number };
}

export interface CoordinationManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: { kind: "coordination"; groupId: string; run: CoordinationRun }) => void;
  groupBots: (groupId: string) => CoordinationBot[];
  createTask: (botId: string, title: string) => { threadId: string } | null;
  runBotTurn: (input: {
    botId: string;
    threadId: string;
    prompt: string;
    signal: AbortSignal;
  }) => Promise<BotTurnResult>;
  interruptBotTurn?: (botId: string, threadId: string) => Promise<void>;
  appendChannelMessage?: (groupId: string, text: string) => void;
}

const ROLES: readonly CoordinationRole[] = ["architect", "developer", "tester", "reviewer"];
const ROLE_WORDS = {
  architect: ["architect", "architecture", "design", "planner", "tech lead", "架构", "设计"],
  developer: ["developer", "engineer", "builder", "implementer", "coder", "开发", "工程"],
  tester: ["tester", "test", "qa", "quality assurance", "测试", "质量"],
  reviewer: ["reviewer", "review", "auditor", "code review", "审查", "评审"],
} as const satisfies Record<CoordinationRole, readonly string[]>;

const ROLE_PROMPTS = {
  architect: "Own architecture and decomposition. State decisions, interfaces, risks, and acceptance criteria. Do not implement work assigned to other roles.",
  developer: "Own implementation. Work in the configured project, make concrete changes, and report changed files and verification evidence.",
  tester: "Own independent verification. Run relevant checks, test acceptance criteria and edge cases, and report exact failures with evidence.",
  reviewer: "Own the final gate. Review implementation and test evidence. End with exactly one line: VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED. If requesting changes, list concrete fixes.",
} as const satisfies Record<CoordinationRole, string>;

interface CoordinationAssignments {
  architect: CoordinationBot;
  developer: CoordinationBot;
  tester: CoordinationBot;
  reviewer: CoordinationBot;
}

function roleScore(bot: CoordinationBot, role: CoordinationRole): number {
  const text = `${bot.name} ${bot.title} ${bot.description}`.toLowerCase();
  return ROLE_WORDS[role].reduce((score, word) => score + (text.includes(word) ? (bot.title.toLowerCase().includes(word) ? 5 : 2) : 0), 0);
}

/** Deterministic, distinct role assignment; explicit profile wording wins, channel order breaks ties. */
export function assignCoordinationRoles(bots: CoordinationBot[]): CoordinationAssignments {
  if (bots.length < ROLES.length) throw new Error("Coordinator needs at least four bots in the channel");
  const remaining = [...bots];
  // SAFETY: the loop below writes every member of the closed ROLES tuple exactly once.
  const assigned = {} as CoordinationAssignments;
  for (const role of ROLES) {
    let bestIndex = 0;
    let bestScore = -1;
    remaining.forEach((bot, index) => {
      const score = roleScore(bot, role);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    });
    assigned[role] = remaining.splice(bestIndex, 1)[0]!;
  }
  return assigned;
}

function inferRole(task: PlanTaskArtifact, index: number, total: number): CoordinationRole {
  const text = `${task.role ?? ""} ${task.assignee ?? ""} ${task.title} ${task.description}`.toLowerCase();
  for (const role of ROLES) if (ROLE_WORDS[role].some((word) => text.includes(word))) return role;
  if (index === 0) return "architect";
  if (index === total - 1) return "reviewer";
  return index === total - 2 ? "tester" : "developer";
}

/** Keep OMA's decomposition and dependencies, while binding every node to one concrete Roundtable role. */
export function normalizeCoordinationPlan(plan: PlanArtifact, goal: string): PlanArtifact {
  const ids = new Set(plan.tasks.map((task) => task.id));
  const tasks = plan.tasks.map((task, index) => {
    const role = inferRole(task, index, plan.tasks.length);
    return {
      ...task,
      role,
      assignee: role,
      dependsOn: (task.dependsOn ?? []).filter((id) => ids.has(id) && id !== task.id),
    } satisfies PlanTaskArtifact;
  });
  if (tasks.length === 0) return fallbackPlan(goal);

  // A review is always the terminal gate, even when the generated plan omitted one.
  const terminalIds = tasks.filter((candidate) => !tasks.some((other) => other.dependsOn?.includes(candidate.id))).map((task) => task.id);
  const reviewerIsTerminal = tasks.some((task) => task.role === "reviewer" && terminalIds.includes(task.id));
  if (!reviewerIsTerminal) {
    tasks.push({
      id: `review-${randomUUID()}`,
      title: "Final implementation review",
      description: `Review the complete result for: ${goal}. Validate the stated acceptance criteria and return the required verdict line.`,
      role: "reviewer",
      assignee: "reviewer",
      dependsOn: terminalIds,
      priority: "critical",
    });
  }
  return { version: 1, goal, tasks };
}

export function fallbackPlan(goal: string): PlanArtifact {
  return {
    version: 1,
    goal,
    tasks: [
      { id: "architecture", title: "Architecture and acceptance plan", description: `Design the solution for: ${goal}`, role: "architect", assignee: "architect" },
      { id: "implementation", title: "Implement the solution", description: `Implement the approved architecture for: ${goal}`, role: "developer", assignee: "developer", dependsOn: ["architecture"] },
      { id: "verification", title: "Verify acceptance criteria", description: `Test the implementation for: ${goal}`, role: "tester", assignee: "tester", dependsOn: ["implementation"] },
      { id: "review", title: "Final implementation review", description: `Review implementation and test evidence for: ${goal}`, role: "reviewer", assignee: "reviewer", dependsOn: ["verification"] },
    ],
  };
}

export function reviewApproved(output: string | undefined): boolean {
  return /VERDICT\s*:\s*APPROVED\b/i.test(output ?? "") && !/VERDICT\s*:\s*CHANGES_REQUESTED\b/i.test(output ?? "");
}

function messageText(messages: LLMMessage[]): string {
  return messages.map((message) => {
    const content = message.content.map((block) => "text" in block ? block.text : block.type === "tool_result" ? String(block.content) : `[${block.type}]`).join("\n");
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
}

class RoundtableAdapter implements LLMAdapter {
  readonly name = "roundtable";
  private readonly invoke: (prompt: string, signal?: AbortSignal) => Promise<BotTurnResult>;

  constructor(invoke: (prompt: string, signal?: AbortSignal) => Promise<BotTurnResult>) {
    this.invoke = invoke;
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const prompt = [options.systemPrompt ? `SYSTEM INSTRUCTIONS:\n${options.systemPrompt}` : "", messageText(messages)].filter(Boolean).join("\n\n");
    const result = await this.invoke(prompt, options.abortSignal);
    return {
      id: randomUUID(),
      content: [{ type: "text", text: result.text }],
      model: options.model,
      stop_reason: "end_turn",
      usage: { input_tokens: result.usage?.input ?? 0, output_tokens: result.usage?.output ?? 0 },
    };
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    try {
      const response = await this.chat(messages, options);
      const text = response.content.find((block) => block.type === "text");
      if (text?.type === "text") yield { type: "text", data: text.text };
      yield { type: "done", data: response };
    } catch (error) {
      yield { type: "error", data: error };
    }
  }
}

export class CoordinationManager {
  private readonly options: CoordinationManagerOptions;
  private readonly file: string;
  private readonly now: () => number;
  private runs: CoordinationRun[] = [];
  private controllers = new Map<string, AbortController>();
  private activeTaskByRole = new Map<string, string>();
  private resumeWaiters = new Map<string, Set<() => void>>();

  constructor(options: CoordinationManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "coordination-runs.json");
    this.now = options.now ?? Date.now;
    this.load();
  }

  latest(groupId: string): CoordinationRun | undefined {
    return this.runs.filter((run) => run.groupId === groupId).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  async start(groupId: string, rawGoal: string): Promise<CoordinationRun> {
    const goal = rawGoal.trim().slice(0, 20_000);
    if (!goal) throw new Error("Tell the coordinator what outcome you want");
    const existing = this.latest(groupId);
    if (existing && ["planning", "running", "paused"].includes(existing.status)) throw new Error("This channel already has an active coordination run");
    const assigned = assignCoordinationRoles(this.options.groupBots(groupId));
    const run: CoordinationRun = {
      id: randomUUID(), groupId, goal, status: "planning", tasks: [], events: [], createdAt: this.now(), fixCycles: 0,
      roles: {
        architect: { botId: assigned.architect.id, botName: assigned.architect.name },
        developer: { botId: assigned.developer.id, botName: assigned.developer.name },
        tester: { botId: assigned.tester.id, botName: assigned.tester.name },
        reviewer: { botId: assigned.reviewer.id, botName: assigned.reviewer.name },
      },
    };
    this.runs.push(run);
    this.event(run, "run", "Coordinator is turning the goal into an execution DAG");
    this.publish(run);
    void this.execute(run, assigned);
    return run;
  }

  pause(groupId: string): CoordinationRun {
    const run = this.requireActive(groupId);
    if (run.status === "running" || run.status === "planning") {
      run.status = "paused";
      this.event(run, "control", "Dispatch paused; running tasks may finish");
      this.publish(run);
    }
    return run;
  }

  resume(groupId: string): CoordinationRun {
    const run = this.requireActive(groupId);
    if (run.status === "paused") {
      run.status = run.tasks.length ? "running" : "planning";
      this.event(run, "control", "Dispatch resumed");
      for (const wake of this.resumeWaiters.get(run.id) ?? []) wake();
      this.resumeWaiters.delete(run.id);
      this.publish(run);
    }
    return run;
  }

  async cancel(groupId: string): Promise<CoordinationRun> {
    const run = this.requireActive(groupId);
    run.status = "cancelled";
    run.finishedAt = this.now();
    this.controllers.get(run.id)?.abort();
    for (const task of run.tasks) {
      if (task.status === "running" && task.threadId) await this.options.interruptBotTurn?.(task.botId, task.threadId).catch(() => {});
      if (["pending", "ready", "running", "blocked"].includes(task.status)) task.status = "cancelled";
    }
    for (const wake of this.resumeWaiters.get(run.id) ?? []) wake();
    this.event(run, "control", "Run cancelled");
    this.publish(run);
    return run;
  }

  async retry(groupId: string, taskId?: string): Promise<CoordinationRun> {
    const previous = this.latest(groupId);
    if (!previous || !["failed", "cancelled"].includes(previous.status)) throw new Error("Only a failed or cancelled run can be retried");
    const failed = taskId ? previous.tasks.find((task) => task.id === taskId) : previous.tasks.find((task) => task.status === "failed");
    const goal = failed ? `${previous.goal}\n\nRetry failed task: ${failed.title}\nPrevious error: ${failed.error ?? "unknown"}` : previous.goal;
    return this.start(groupId, goal);
  }

  private requireActive(groupId: string): CoordinationRun {
    const run = this.latest(groupId);
    if (!run || !["planning", "running", "paused"].includes(run.status)) throw new Error("This channel has no active coordination run");
    return run;
  }

  private async execute(run: CoordinationRun, assigned: CoordinationAssignments): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    try {
      const orchestrator = new OpenMultiAgent({
        defaultModel: "roundtable",
        maxConcurrency: 4,
        schedulingStrategy: "dependency-first",
        strictAssignees: true,
        onProgress: (event) => this.onProgress(run, event),
        onTaskDispatch: async () => {
          await this.waitWhilePaused(run, controller.signal);
          return run.status === "cancelled" ? false : true;
        },
      });
      const adapterFor = (role: CoordinationRole) => new RoundtableAdapter((prompt, signal) => this.invokeRole(run, role, prompt, signal ?? controller.signal));
      const adapters = { architect: adapterFor("architect"), developer: adapterFor("developer"), tester: adapterFor("tester"), reviewer: adapterFor("reviewer") };
      const team = orchestrator.createTeam(`roundtable-${run.id}`, {
        name: `roundtable-${run.id}`,
        sharedMemory: true,
        maxConcurrency: 4,
        agents: ROLES.map((role) => ({ name: role, description: ROLE_PROMPTS[role], capabilities: [role], model: assigned[role].model || "roundtable", systemPrompt: ROLE_PROMPTS[role], adapter: adapters[role] })),
      });

      const planningAdapter = new RoundtableAdapter((prompt, signal) => this.invokePlanning(run, assigned.architect, prompt, signal ?? controller.signal));
      let plan: PlanArtifact;
      try {
        const preview = await orchestrator.runTeam(team, run.goal, {
          mode: "team",
          planOnly: true,
          coordinator: {
            model: assigned.architect.model || "roundtable",
            adapter: planningAdapter,
            instructions: "Create a concrete implementation DAG. Use only architect, developer, tester, reviewer as assignees. Include implementation and verification work; reviewer must be the terminal gate.",
          },
          abortSignal: controller.signal,
        });
        plan = normalizeCoordinationPlan(orchestrator.createPlanArtifact(preview), run.goal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        plan = fallbackPlan(run.goal);
        this.event(run, "run", `Dynamic planning fell back to the standard four-stage DAG: ${error instanceof Error ? error.message : String(error)}`);
      }

      run.tasks = plan.tasks.map((task) => this.toRunTask(task, assigned));
      run.status = run.status === "paused" ? "paused" : "running";
      run.startedAt = this.now();
      this.event(run, "run", `DAG ready with ${run.tasks.length} tasks`);
      this.publish(run);
      const result = await orchestrator.runFromPlan(team, plan, { abortSignal: controller.signal });
      this.applyResult(run, result);
      if (controller.signal.aborted) return;

      const reviewer = [...run.tasks].reverse().find((task) => task.role === "reviewer" && task.status === "completed");
      if (reviewer && !reviewApproved(reviewer.output) && run.fixCycles < 2) {
        await this.runFixCycle(run, orchestrator, team, assigned, reviewer, controller.signal);
      }
      const failed = run.tasks.some((task) => task.status === "failed" || task.status === "blocked");
      run.status = failed ? "failed" : "completed";
      run.finishedAt = this.now();
      run.error = failed ? "One or more DAG tasks did not complete" : undefined;
      run.report = buildCoordinationReport(run);
      this.event(run, "run", failed ? "Run finished with failures" : "Run completed");
      this.options.appendChannelMessage?.(run.groupId, run.report);
      this.publish(run);
    } catch (error) {
      if (run.status !== "cancelled") {
        run.status = "failed";
        run.finishedAt = this.now();
        run.error = error instanceof Error ? error.message : String(error);
        for (const task of run.tasks) if (["pending", "ready", "running"].includes(task.status)) task.status = "blocked";
        run.report = buildCoordinationReport(run);
        this.event(run, "run", `Run failed: ${run.error}`);
        this.options.appendChannelMessage?.(run.groupId, run.report);
        this.publish(run);
      }
    } finally {
      this.controllers.delete(run.id);
      for (const role of ROLES) this.activeTaskByRole.delete(`${run.id}:${role}`);
    }
  }

  private async runFixCycle(
    run: CoordinationRun,
    orchestrator: OpenMultiAgent,
    team: ReturnType<OpenMultiAgent["createTeam"]>,
    assigned: CoordinationAssignments,
    rejected: CoordinationTask,
    signal: AbortSignal,
  ): Promise<void> {
    run.fixCycles += 1;
    const cycle = run.fixCycles;
    this.event(run, "review", `Reviewer requested changes; generating Fix tasks (cycle ${cycle}/2)`, rejected.id);
    const ids = { fix: `fix-${cycle}-${randomUUID()}`, test: `fix-test-${cycle}-${randomUUID()}`, review: `fix-review-${cycle}-${randomUUID()}` };
    const plan: PlanArtifact = { version: 1, goal: run.goal, tasks: [
      { id: ids.fix, title: `Fix reviewer findings (cycle ${cycle})`, description: `Apply these reviewer findings:\n${rejected.output ?? "No details supplied"}`, role: "developer", assignee: "developer" },
      { id: ids.test, title: `Verify fixes (cycle ${cycle})`, description: "Re-run relevant tests and verify every reviewer finding is resolved.", role: "tester", assignee: "tester", dependsOn: [ids.fix] },
      { id: ids.review, title: `Review fixes (cycle ${cycle})`, description: `Review the fix and verification evidence against the original goal: ${run.goal}`, role: "reviewer", assignee: "reviewer", dependsOn: [ids.test] },
    ] };
    const added = plan.tasks.map((task) => this.toRunTask(task, assigned, cycle));
    added[0]!.dependsOn = [rejected.id]; // UI lineage; OMA's sub-plan remains independently executable.
    run.tasks.push(...added);
    this.publish(run);
    const result = await orchestrator.runFromPlan(team, plan, { abortSignal: signal });
    this.applyResult(run, result);
    const nextReview = run.tasks.find((task) => task.id === ids.review);
    if (nextReview && !reviewApproved(nextReview.output) && run.fixCycles < 2) {
      await this.runFixCycle(run, orchestrator, team, assigned, nextReview, signal);
    }
  }

  private toRunTask(task: PlanTaskArtifact, assigned: CoordinationAssignments, fixCycle?: number): CoordinationTask {
    // SAFETY: membership in the closed ROLES tuple is checked before preserving OMA's string role.
    const role = (ROLES.includes(task.role as CoordinationRole) ? task.role : inferRole(task, 0, 1)) as CoordinationRole;
    return { id: task.id, title: task.title, description: task.description, role, botId: assigned[role].id, botName: assigned[role].name, dependsOn: [...(task.dependsOn ?? [])], status: "pending", attempt: 1, fixCycle };
  }

  private async invokePlanning(run: CoordinationRun, bot: CoordinationBot, prompt: string, signal: AbortSignal): Promise<BotTurnResult> {
    let task = run.tasks.find((item) => item.id === "planning");
    if (!task) {
      task = { id: "planning", title: "Plan coordination run", description: run.goal, role: "architect", botId: bot.id, botName: bot.name, dependsOn: [], status: "running", attempt: 1, startedAt: this.now() };
      run.tasks.push(task);
      this.publish(run);
    }
    return this.invokeTask(run, task, prompt, signal);
  }

  private async invokeRole(run: CoordinationRun, role: CoordinationRole, prompt: string, signal: AbortSignal): Promise<BotTurnResult> {
    const activeId = this.activeTaskByRole.get(`${run.id}:${role}`);
    const task = run.tasks.find((item) => item.id === activeId) ?? run.tasks.find((item) => item.role === role && item.status === "running");
    if (!task) throw new Error(`OMA dispatched ${role} without an active task`);
    return this.invokeTask(run, task, prompt, signal);
  }

  private async invokeTask(run: CoordinationRun, task: CoordinationTask, prompt: string, signal: AbortSignal): Promise<BotTurnResult> {
    if (!task.threadId) {
      const detached = this.options.createTask(task.botId, `[${task.role}] ${task.title}`);
      if (!detached) throw new Error(`Could not create a conversation for ${task.botName}`);
      task.threadId = detached.threadId;
      this.publish(run);
    }
    const result = await this.options.runBotTurn({ botId: task.botId, threadId: task.threadId, prompt, signal });
    task.output = result.text;
    return result;
  }

  private onProgress(run: CoordinationRun, event: OrchestratorEvent): void {
    const task = event.task ? run.tasks.find((candidate) => candidate.id === event.task) : undefined;
    if (event.type === "task_start" && task) {
      task.status = "running";
      task.startedAt ??= this.now();
      if (event.agent) this.activeTaskByRole.set(`${run.id}:${event.agent}`, task.id);
      this.event(run, "task", `${task.botName} started ${task.title}`, task.id);
    } else if (event.type === "task_complete" && task) {
      task.status = "completed";
      task.finishedAt = this.now();
      this.event(run, "task", `${task.title} completed`, task.id);
    } else if ((event.type === "error" || event.type === "task_skipped") && task) {
      task.status = event.type === "task_skipped" ? "blocked" : "failed";
      task.finishedAt = this.now();
      task.error = event.type === "task_skipped" ? "Dependency or dispatch was blocked" : String(event.data ?? "Task failed");
      this.event(run, "task", `${task.title} ${task.status}`, task.id);
    } else if (event.type === "task_retry" && task) {
      task.attempt += 1;
      this.event(run, "task", `${task.title} retry ${task.attempt}`, task.id);
    }
    if (task) this.publish(run);
  }

  private applyResult(run: CoordinationRun, result: TeamRunResult): void {
    for (const record of result.tasks ?? []) {
      const task = run.tasks.find((candidate) => candidate.id === record.id);
      if (!task) continue;
      switch (record.status) {
        case "completed": task.status = "completed"; break;
        case "failed": task.status = "failed"; break;
        case "blocked": case "skipped": task.status = "blocked"; break;
        case "pending": task.status = "pending"; break;
      }
      if (["completed", "failed", "blocked"].includes(task.status)) task.finishedAt ??= this.now();
      const output = result.taskResults?.get(record.id)?.output;
      if (output !== undefined) task.output = output;
    }
    this.publish(run);
  }

  private async waitWhilePaused(run: CoordinationRun, signal: AbortSignal): Promise<void> {
    while (run.status === "paused" && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const waiters = this.resumeWaiters.get(run.id) ?? new Set();
        waiters.add(resolve);
        this.resumeWaiters.set(run.id, waiters);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  private event(run: CoordinationRun, type: CoordinationEvent["type"], message: string, taskId?: string): void {
    run.events.push({ id: randomUUID(), at: this.now(), type, message, taskId });
    run.events = run.events.slice(-500);
  }

  private publish(run: CoordinationRun): void {
    this.save();
    this.options.emit?.({ kind: "coordination", groupId: run.groupId, run });
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      // SAFETY: version/array guards below reject any incompatible persisted envelope before use.
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as CoordinationFile;
      if (parsed.version === 1 && Array.isArray(parsed.runs)) {
        this.runs = parsed.runs;
        for (const run of this.runs) {
          if (["planning", "running", "paused"].includes(run.status)) {
            run.status = "failed";
            run.finishedAt = this.now();
            run.error = "Roundtable restarted while this run was active; retry to continue";
            for (const task of run.tasks) if (["pending", "ready", "running"].includes(task.status)) task.status = "blocked";
          }
        }
      }
    } catch {
      this.runs = [];
    }
  }

  private save(): void {
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, runs: this.runs.slice(-200) } satisfies CoordinationFile, null, 2)}\n`);
  }
}

export function buildCoordinationReport(run: CoordinationRun): string {
  const duration = Math.max(0, (run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt));
  const lines = [
    `# Coordinator report — ${run.status}`,
    "",
    `**Goal:** ${run.goal}`,
    `**Duration:** ${(duration / 1000).toFixed(1)}s`,
    `**Fix cycles:** ${run.fixCycles}`,
    "",
    "## Tasks",
    ...run.tasks.map((task) => `- ${task.status === "completed" ? "✓" : task.status === "failed" ? "✗" : "•"} ${task.title} — ${task.botName} (${task.role})${task.error ? `: ${task.error}` : ""}`),
    "",
    "## Timeline",
    ...run.events.map((event) => `- ${new Date(event.at).toLocaleTimeString()} — ${event.message}`),
  ];
  if (run.error) lines.push("", `**Run error:** ${run.error}`);
  return lines.join("\n");
}
