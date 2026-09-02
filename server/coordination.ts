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
import { z } from "zod";
import type { ModelSelection } from "./contracts.ts";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export type CoordinationRole = "architect" | "developer" | "tester" | "reviewer";
export type CoordinationRunStatus = "planning" | "validating" | "planning_blocked" | "running" | "paused" | "reviewing" | "completed" | "failed" | "cancelled";
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
  usage?: { input: number; output: number; cost?: number | null };
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
  plannerBotId?: string;
  plannerBotName?: string;
  plannerSelectionReason?: string;
  requestedBotIds: string[];
  policySnapshot: {
    maxConcurrency: number;
    maxFixCycles: number;
    requirePlanApproval: boolean;
    planningRetries: number;
    maxRunMinutes: number;
    requireHighRiskReview: boolean;
    failureMode: "pause" | "fallback";
  };
  coordinatorSnapshot: {
    requestedModel: ModelSelection;
    actualModel?: ModelSelection;
    backupModel?: ModelSelection;
    modelPolicyVersion: number;
    promptVersion: string;
    runtimePolicyVersion: number;
    planningBudget: { timeoutMs: number; maxTokens?: number; maxCost?: number };
  };
  planRevisions: Array<{
    revision: number;
    at: number;
    model: ModelSelection;
    accepted: boolean;
    reason?: string;
    latencyMs: number;
    usage?: { input: number; output: number; cost?: number | null };
    fallbackReason?: string;
  }>;
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
  usage?: { input: number; output: number; cost?: number | null };
}

export interface CoordinatorRuntimePolicy {
  primary: ModelSelection;
  backup?: ModelSelection;
  failureMode: "pause" | "fallback";
  planningTimeoutMs: number;
  planningRetries: number;
  maxConcurrency: number;
  maxFixCycles: number;
  maxRunMinutes: number;
  maxTokens?: number;
  maxCostUsd?: number;
  requireHighRiskReview: boolean;
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
  coordinatorPolicy: () => CoordinatorRuntimePolicy;
  runCoordinatorTurn: (input: {
    runId: string;
    revision: number;
    selection: ModelSelection;
    prompt: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<BotTurnResult>;
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

export const COORDINATOR_PROMPT_VERSION = "coordinator-planner-v1";
export const COORDINATOR_SYSTEM_PROMPT = [
  "You are Roundtable Coordinator Intelligence, an untrusted planning dependency with no tools or execution authority.",
  "Propose the smallest safe task DAG for the supplied goal and context.",
  "Use only architect, developer, tester, or reviewer roles.",
  "Return JSON only: an array of objects with title, description, role, assignee, and optional dependsOn title array.",
  "Never claim that you changed runtime state, ran tools, approved actions, or completed tasks.",
].join(" ");

const coordinatorProposalSchema = z.array(z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.enum(ROLES).optional(),
  assignee: z.enum(ROLES).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
})).min(1).max(100);

function parseCoordinatorProposal(text: string, goal: string): PlanArtifact {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Coordinator returned non-JSON output");
  }
  const parsed = coordinatorProposalSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`Coordinator returned an invalid proposal: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  const used = new Set<string>();
  const withIds = parsed.data.map((task, index) => {
    const generated = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const base = task.id ?? (generated || `task-${index + 1}`);
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
    used.add(id);
    return { ...task, id };
  });
  const references = new Map<string, string>();
  for (const task of withIds) {
    references.set(task.id, task.id);
    references.set(task.title, task.id);
  }
  return {
    version: 1,
    goal,
    tasks: withIds.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      role: task.role,
      assignee: task.assignee ?? task.role,
      dependsOn: task.dependsOn?.map((dependency) => references.get(dependency) ?? dependency),
    })),
  };
}

interface CoordinationAssignments {
  architect: CoordinationBot;
  developer: CoordinationBot;
  tester: CoordinationBot;
  reviewer: CoordinationBot;
}

interface CoordinationPlanBinding {
  plan: PlanArtifact;
  bindings: Map<string, CoordinationBot>;
}

function roleScore(bot: CoordinationBot, role: CoordinationRole): number {
  const text = `${bot.name} ${bot.title} ${bot.description}`.toLowerCase();
  return ROLE_WORDS[role].reduce((score, word) => score + (text.includes(word) ? (bot.title.toLowerCase().includes(word) ? 5 : 2) : 0), 0);
}

function requestedBots(goal: string, bots: CoordinationBot[]): CoordinationBot[] {
  if (/(?:^|\s)@everyone\b/i.test(goal)) return [...bots];
  const lower = goal.toLowerCase();
  return bots
    .filter((bot) => {
      const needle = `@${bot.name.toLowerCase()}`;
      const at = lower.indexOf(needle);
      if (at < 0 || (at > 0 && !/\s/.test(goal[at - 1]!))) return false;
      const after = lower[at + needle.length];
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
}

function bestRole(bot: CoordinationBot): CoordinationRole {
  return [...ROLES].sort((a, b) => roleScore(bot, b) - roleScore(bot, a))[0]!;
}

/** Deterministic, distinct role assignment; explicit profile wording wins, channel order breaks ties. */
export function assignCoordinationRoles(bots: CoordinationBot[]): CoordinationAssignments {
  if (bots.length === 0) throw new Error("Coordinator needs at least one active bot in the channel");
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
    assigned[role] = remaining.length
      ? remaining.splice(bestIndex, 1)[0]!
      : [...bots].sort((a, b) => roleScore(b, role) - roleScore(a, role))[0]!;
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
export function normalizeCoordinationPlan(plan: PlanArtifact, goal: string, requireHighRiskReview = true): PlanArtifact {
  const tasks = plan.tasks.map((task, index) => {
    const role = inferRole(task, index, plan.tasks.length);
    return {
      ...task,
      role,
      assignee: role,
      dependsOn: [...(task.dependsOn ?? [])],
    } satisfies PlanTaskArtifact;
  });
  if (tasks.length === 0) return { version: 1, goal, tasks: [] };

  // Multi-step and risk-sensitive work gets a terminal Reviewer gate. A truly
  // simple goal may remain one task, which is the key Coordinator v2 cost rule.
  const terminalIds = tasks.filter((candidate) => !tasks.some((other) => other.dependsOn?.includes(candidate.id))).map((task) => task.id);
  const reviewerIsTerminal = tasks.some((task) => task.role === "reviewer" && terminalIds.includes(task.id));
  const highRisk = /\b(security|auth|payment|billing|production|deploy|delete|migration|permission|credential)\b|安全|生产|部署|删除|迁移|权限|凭据/i.test(goal);
  if (!reviewerIsTerminal && (tasks.length > 1 || (requireHighRiskReview && highRisk))) {
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

/** Runtime-owned validation. Intelligence output is never executable until this passes. */
export function validateCoordinationPlan(plan: PlanArtifact): void {
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error("The proposal contains no tasks");
  if (plan.tasks.length > 100) throw new Error("The proposal exceeds the 100-task safety limit");
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (!task.id || ids.has(task.id)) throw new Error(`Task IDs must be non-empty and unique: ${task.id || "(empty)"}`);
    ids.add(task.id);
    if (!task.title?.trim() || !task.description?.trim()) throw new Error(`Task ${task.id} needs a title and description`);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`The proposal contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function fallbackPlan(goal: string): PlanArtifact {
  const complex = /\b(implement|build|fix|refactor|migrate|ship|test|review|design|architecture|feature)\b|实现|构建|修复|重构|迁移|发布|测试|评审|设计|架构|功能/i.test(goal);
  if (!complex) {
    return {
      version: 1,
      goal,
      tasks: [{ id: "execute", title: "Complete the goal", description: goal, role: "developer", assignee: "developer" }],
    };
  }
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

  async testCoordinator(): Promise<{ ok: true; latencyMs: number; model: ModelSelection; taskCount: number }> {
    const policy = this.options.coordinatorPolicy();
    const controller = new AbortController();
    const startedAt = this.now();
    const result = await this.options.runCoordinatorTurn({
      runId: `test-${randomUUID()}`,
      revision: 1,
      selection: policy.primary,
      prompt: `${COORDINATOR_SYSTEM_PROMPT}\n\nGoal: Reply to a user greeting. Return a one-task JSON plan and nothing else.`,
      timeoutMs: policy.planningTimeoutMs,
      signal: controller.signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new Error("Coordinator returned non-JSON output");
    }
    if (!Array.isArray(parsed) || parsed.length < 1) throw new Error("Coordinator returned an empty or invalid plan");
    return { ok: true, latencyMs: this.now() - startedAt, model: policy.primary, taskCount: parsed.length };
  }

  validateStart(groupId: string, rawGoal: string): void {
    if (!rawGoal.trim()) throw new Error("Tell the coordinator what outcome you want");
    const existing = this.latest(groupId);
    if (existing && ["planning", "validating", "running", "paused", "reviewing"].includes(existing.status)) {
      throw new Error("This channel already has an active coordination run");
    }
    if (this.options.groupBots(groupId).length === 0) {
      throw new Error("Coordinator needs at least one active bot in the channel");
    }
  }

  async start(groupId: string, rawGoal: string): Promise<CoordinationRun> {
    const goal = rawGoal.trim().slice(0, 20_000);
    this.validateStart(groupId, goal);
    const bots = this.options.groupBots(groupId);
    const assigned = assignCoordinationRoles(bots);
    const policy = this.options.coordinatorPolicy();
    const requested = requestedBots(goal, bots);
    const run: CoordinationRun = {
      id: randomUUID(), groupId, goal, status: "planning", tasks: [], events: [], createdAt: this.now(), fixCycles: 0,
      requestedBotIds: requested.map((bot) => bot.id),
      policySnapshot: {
        maxConcurrency: Math.min(policy.maxConcurrency, Math.max(1, bots.length)),
        maxFixCycles: policy.maxFixCycles,
        requirePlanApproval: false,
        planningRetries: policy.planningRetries,
        maxRunMinutes: policy.maxRunMinutes,
        requireHighRiskReview: policy.requireHighRiskReview,
        failureMode: policy.failureMode,
      },
      coordinatorSnapshot: {
        requestedModel: structuredClone(policy.primary),
        backupModel: policy.backup ? structuredClone(policy.backup) : undefined,
        modelPolicyVersion: 1,
        promptVersion: COORDINATOR_PROMPT_VERSION,
        runtimePolicyVersion: 1,
        planningBudget: { timeoutMs: policy.planningTimeoutMs, maxTokens: policy.maxTokens, maxCost: policy.maxCostUsd },
      },
      planRevisions: [],
      roles: {
        architect: { botId: assigned.architect.id, botName: assigned.architect.name },
        developer: { botId: assigned.developer.id, botName: assigned.developer.name },
        tester: { botId: assigned.tester.id, botName: assigned.tester.name },
        reviewer: { botId: assigned.reviewer.id, botName: assigned.reviewer.name },
      },
    };
    this.runs.push(run);
    this.event(run, "run", `Coordinator Intelligence pinned to ${policy.primary.instanceId} / ${policy.primary.model}`);
    if (requested.length) this.event(run, "run", `Scheduling constraint: include ${requested.map((bot) => bot.name).join(", ")}`);
    this.event(run, "run", "Coordinator is turning the goal into an execution DAG");
    this.publish(run);
    void this.execute(run, assigned);
    return run;
  }

  pause(groupId: string): CoordinationRun {
    const run = this.requireActive(groupId);
    if (run.status === "running" || run.status === "planning" || run.status === "reviewing") {
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
    run.report = buildCoordinationReport(run);
    this.options.appendChannelMessage?.(run.groupId, run.report);
    this.publish(run);
    return run;
  }

  async retry(groupId: string, taskId?: string): Promise<CoordinationRun> {
    const previous = this.latest(groupId);
    if (!previous || !["failed", "cancelled", "planning_blocked"].includes(previous.status)) throw new Error("Only a blocked, failed, or cancelled run can be retried");
    const failed = taskId ? previous.tasks.find((task) => task.id === taskId) : previous.tasks.find((task) => task.status === "failed");
    const goal = failed ? `${previous.goal}\n\nRetry failed task: ${failed.title}\nPrevious error: ${failed.error ?? "unknown"}` : previous.goal;
    return this.start(groupId, goal);
  }

  private requireActive(groupId: string): CoordinationRun {
    const run = this.latest(groupId);
    if (!run || !["planning", "validating", "running", "paused", "reviewing"].includes(run.status)) throw new Error("This channel has no active coordination run");
    return run;
  }

  private async execute(run: CoordinationRun, assigned: CoordinationAssignments): Promise<void> {
    const controller = new AbortController();
    const runTimer = setTimeout(() => controller.abort(), run.policySnapshot.maxRunMinutes * 60_000);
    this.controllers.set(run.id, controller);
    try {
      const bots = this.options.groupBots(run.groupId);
      const requested = bots.filter((bot) => run.requestedBotIds.includes(bot.id));
      const orchestrator = new OpenMultiAgent({
        defaultModel: "roundtable",
        maxConcurrency: run.policySnapshot.maxConcurrency,
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
        maxConcurrency: run.policySnapshot.maxConcurrency,
        agents: ROLES.map((role) => ({ name: role, description: ROLE_PROMPTS[role], capabilities: [role], model: assigned[role].model || "roundtable", systemPrompt: ROLE_PROMPTS[role], adapter: adapters[role] })),
      });

      let plan: PlanArtifact;
      let pausedAfterPlanning = false;
      try {
        const compiledContext = {
          goal: run.goal,
          constraints: requested.length
            ? [`Include work for these bot IDs: ${requested.map((bot) => bot.id).join(", ")}`]
            : [],
          availableBots: bots.map((bot) => ({ id: bot.id, name: bot.name, capabilities: `${bot.title}: ${bot.description}`.slice(0, 500) })),
          runtimePolicy: {
            maxConcurrency: run.policySnapshot.maxConcurrency,
            maxFixCycles: run.policySnapshot.maxFixCycles,
            requireHighRiskReview: run.policySnapshot.requireHighRiskReview,
          },
        };
        const proposal = await this.invokeCoordinatorPlanning(
          run,
          `Create the smallest safe DAG from this untrusted context.\n<runtime_context>\n${JSON.stringify(compiledContext)}\n</runtime_context>`,
          controller.signal,
        );
        pausedAfterPlanning = run.status === "paused";
        if (!pausedAfterPlanning) {
          run.status = "validating";
          this.publish(run);
        }
        plan = normalizeCoordinationPlan(parseCoordinatorProposal(proposal.text, run.goal), run.goal, run.policySnapshot.requireHighRiskReview);
        validateCoordinationPlan(plan);
        const revision = run.planRevisions.at(-1);
        if (revision) revision.accepted = true;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const revision = run.planRevisions.at(-1);
        if (revision) {
          revision.accepted = false;
          revision.reason = reason;
        }
        run.status = "planning_blocked";
        run.error = reason;
        run.finishedAt = this.now();
        this.event(run, "run", `Planning blocked: ${reason}`);
        this.publish(run);
        return;
      }

      const bound = this.bindRequestedBots(plan, requested, assigned);
      plan = bound.plan;
      const bindings = bound.bindings;
      run.tasks = plan.tasks.map((task) => this.toRunTask(task, assigned, undefined, bindings.get(task.id)));
      run.status = pausedAfterPlanning ? "paused" : "running";
      run.startedAt = this.now();
      this.event(run, "run", `DAG ready with ${run.tasks.length} tasks`);
      this.publish(run);
      const result = await orchestrator.runFromPlan(team, plan, { abortSignal: controller.signal });
      this.applyResult(run, result);
      if (controller.signal.aborted) return;

      const reviewer = [...run.tasks].reverse().find((task) => task.role === "reviewer" && task.status === "completed");
      if (reviewer && !reviewApproved(reviewer.output) && run.fixCycles < run.policySnapshot.maxFixCycles) {
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
      clearTimeout(runTimer);
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
    if (run.status !== "paused") run.status = "running";
    run.fixCycles += 1;
    const cycle = run.fixCycles;
    this.event(run, "review", `Reviewer requested changes; generating Fix tasks (cycle ${cycle}/${run.policySnapshot.maxFixCycles})`, rejected.id);
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
    if (nextReview && !reviewApproved(nextReview.output) && run.fixCycles < run.policySnapshot.maxFixCycles) {
      await this.runFixCycle(run, orchestrator, team, assigned, nextReview, signal);
    }
  }

  private bindRequestedBots(
    plan: PlanArtifact,
    requested: CoordinationBot[],
    assigned: CoordinationAssignments,
  ): CoordinationPlanBinding {
    const bindings = new Map<string, CoordinationBot>();
    const tasks: PlanTaskArtifact[] = plan.tasks.map((task) => ({ ...task, dependsOn: [...(task.dependsOn ?? [])] }));
    const available = [...tasks];
    for (const bot of requested) {
      const preferred = bestRole(bot);
      let index = available.findIndex((task) => inferRole(task, 0, 1) === preferred);
      if (index < 0) index = 0;
      let task = available.splice(index, 1)[0];
      if (!task) {
        const role = preferred;
        task = {
          id: `participate-${bot.id}-${randomUUID()}`,
          title: `${bot.name} contribution`,
          description: `Contribute your specialist perspective to the goal: ${plan.goal}`,
          role,
          assignee: role,
        };
        const reviewIndex = tasks.findIndex((candidate) => inferRole(candidate, 0, 1) === "reviewer");
        if (reviewIndex >= 0) {
          const review = tasks[reviewIndex]!;
          tasks[reviewIndex] = { ...review, dependsOn: [...new Set([...(review.dependsOn ?? []), task.id])] };
        }
        tasks.push(task);
      }
      bindings.set(task.id, bot);
    }
    for (const task of tasks) {
      if (bindings.has(task.id)) continue;
      const role = inferRole(task, 0, 1);
      bindings.set(task.id, assigned[role]);
    }
    return { plan: { ...plan, tasks }, bindings };
  }

  private toRunTask(task: PlanTaskArtifact, assigned: CoordinationAssignments, fixCycle?: number, botOverride?: CoordinationBot): CoordinationTask {
    // SAFETY: membership in the closed ROLES tuple is checked before preserving OMA's string role.
    const role = (ROLES.includes(task.role as CoordinationRole) ? task.role : inferRole(task, 0, 1)) as CoordinationRole;
    const bot = botOverride ?? assigned[role];
    return { id: task.id, title: task.title, description: task.description, role, botId: bot.id, botName: bot.name, dependsOn: [...(task.dependsOn ?? [])], status: "pending", attempt: 1, fixCycle };
  }

  private async invokeCoordinatorPlanning(run: CoordinationRun, prompt: string, signal: AbortSignal): Promise<BotTurnResult> {
    const selections = [run.coordinatorSnapshot.requestedModel];
    if (run.policySnapshot.failureMode === "fallback" && run.coordinatorSnapshot.backupModel) {
      selections.push(run.coordinatorSnapshot.backupModel);
    }
    let lastError: unknown;
    for (let modelIndex = 0; modelIndex < selections.length; modelIndex += 1) {
      const selection = selections[modelIndex]!;
      for (let attempt = 0; attempt <= run.policySnapshot.planningRetries; attempt += 1) {
        const startedAt = this.now();
        const revision = run.planRevisions.length + 1;
        try {
          const result = await this.options.runCoordinatorTurn({
            runId: run.id,
            revision,
            selection,
            prompt,
            timeoutMs: run.coordinatorSnapshot.planningBudget.timeoutMs,
            signal,
          });
          run.coordinatorSnapshot.actualModel = structuredClone(selection);
          run.planRevisions.push({
            revision,
            at: this.now(),
            model: structuredClone(selection),
            accepted: false,
            latencyMs: this.now() - startedAt,
            usage: result.usage,
            fallbackReason: modelIndex > 0 ? (lastError instanceof Error ? lastError.message : String(lastError)) : undefined,
          });
          this.publish(run);
          const planningTokens = (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
          if (run.coordinatorSnapshot.planningBudget.maxTokens !== undefined && planningTokens > run.coordinatorSnapshot.planningBudget.maxTokens) {
            throw new Error(`Coordinator planning exceeded the ${run.coordinatorSnapshot.planningBudget.maxTokens}-token budget`);
          }
          if (run.coordinatorSnapshot.planningBudget.maxCost !== undefined && (result.usage?.cost ?? 0) > run.coordinatorSnapshot.planningBudget.maxCost) {
            throw new Error(`Coordinator planning exceeded the $${run.coordinatorSnapshot.planningBudget.maxCost} cost budget`);
          }
          return result;
        } catch (error) {
          lastError = error;
          if (!run.planRevisions.some((entry) => entry.revision === revision)) {
            run.planRevisions.push({
              revision,
              at: this.now(),
              model: structuredClone(selection),
              accepted: false,
              reason: error instanceof Error ? error.message : String(error),
              latencyMs: this.now() - startedAt,
              fallbackReason: modelIndex > 0 ? "Primary model attempts failed" : undefined,
            });
          }
          this.event(run, "run", `Planning attempt ${attempt + 1} failed on ${selection.instanceId}: ${error instanceof Error ? error.message : String(error)}`);
          this.publish(run);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Coordinator planning failed"));
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
    task.usage = result.usage;
    return result;
  }

  private onProgress(run: CoordinationRun, event: OrchestratorEvent): void {
    const task = event.task ? run.tasks.find((candidate) => candidate.id === event.task) : undefined;
    if (event.type === "task_start" && task) {
      task.status = "running";
      if (task.role === "reviewer" && run.status !== "paused") run.status = "reviewing";
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
          run.requestedBotIds ??= [];
          run.policySnapshot.planningRetries ??= 1;
          run.policySnapshot.maxRunMinutes ??= 60;
          run.policySnapshot.requireHighRiskReview ??= true;
          run.policySnapshot.failureMode ??= "pause";
          run.coordinatorSnapshot ??= {
            requestedModel: { instanceId: "", model: "" },
            modelPolicyVersion: 1,
            promptVersion: COORDINATOR_PROMPT_VERSION,
            runtimePolicyVersion: 1,
            planningBudget: { timeoutMs: 120_000 },
          };
          run.planRevisions ??= [];
          if (["planning", "validating", "running", "paused", "reviewing"].includes(run.status)) {
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
  const coordinatorUsage = run.planRevisions.reduce((sum, revision) => sum + (revision.usage?.input ?? 0) + (revision.usage?.output ?? 0), 0);
  const botUsage = run.tasks.reduce((sum, task) => sum + (task.usage?.input ?? 0) + (task.usage?.output ?? 0), 0);
  const lines = [
    `# Coordinator report — ${run.status}`,
    "",
    `**Goal:** ${run.goal}`,
    `**Duration:** ${(duration / 1000).toFixed(1)}s`,
    `**Fix cycles:** ${run.fixCycles}`,
    `**Usage:** ${coordinatorUsage.toLocaleString()} Coordinator tokens · ${botUsage.toLocaleString()} Bot tokens`,
    "",
    "## Tasks",
    ...run.tasks.map((task) => `- ${task.status === "completed" ? "✓" : task.status === "failed" ? "✗" : "•"} ${task.title} — ${task.botName} (${task.role})${task.error ? `: ${task.error}` : ""}${task.threadId ? ` [task ${task.threadId}]` : ""}`),
    "",
    "## Reviewer verdict",
    ...(() => {
      const reviews = run.tasks.filter((task) => task.role === "reviewer");
      if (!reviews.length) return ["- Not required for this run."];
      return reviews.map((task) => `- ${task.title}: ${reviewApproved(task.output) ? "APPROVED" : /CHANGES_REQUESTED/i.test(task.output ?? "") ? "CHANGES_REQUESTED" : task.status.toUpperCase()}`);
    })(),
    "",
    "## Failures and approvals",
    ...(run.tasks.some((task) => task.error)
      ? run.tasks.filter((task) => task.error).map((task) => `- ${task.title}: ${task.error}`)
      : ["- No task failures recorded."]),
    "- Tool approvals remain enforced and auditable in each linked Bot task; Coordinator does not bypass them.",
    "",
    "## Timeline",
    ...run.events.map((event) => `- ${new Date(event.at).toLocaleTimeString()} — ${event.message}`),
  ];
  if (run.error) lines.push("", `**Run error:** ${run.error}`);
  return lines.join("\n");
}
