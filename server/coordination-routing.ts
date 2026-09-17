import { z } from "zod";
import type { CoordinationBot } from "./coordination.ts";

const dispatchSchema = z.object({
  action: z.literal("dispatch"),
  botId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(20_000),
  state: z.enum(["conversation", "project"]),
  risk: z.literal("low"),
  requiresReview: z.literal(false),
}).strict();

export type DirectDispatch = z.infer<typeof dispatchSchema>;

export const planningRequestSchema = z.object({
  reason: z.string().trim().min(1).max(4_000),
  evidence: z.string().trim().min(1).max(20_000),
  completedActions: z.array(z.string().trim().min(1).max(2_000)).max(100),
  remainingWork: z.string().trim().min(1).max(8_000),
}).strict();

export type PlanningRequest = z.infer<typeof planningRequestSchema>;
export const planningControlSchema = z.object({
  fromBotId: z.string().trim().min(1).max(200),
  fromThreadId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(200),
  taskId: z.string().trim().min(1).max(200),
  request: planningRequestSchema,
}).strict();

export function isRiskSensitiveGoal(goal: string): boolean {
  return /\b(security|auth|payment|billing|production|deploy|delete|migration|permission|credential)\b|安全|生产|部署|删除|迁移|权限|凭据/i.test(goal);
}

export function requiresExplicitReview(goal: string): boolean {
  return /\b(review|reviewer|approval gate)\b|审查|审核|评审/i.test(goal);
}

/** Only the initial Coordinator response is parsed here, never conversation or tool text. */
export function parseCoordinationRouting(text: string): DirectDispatch | { action: "plan"; tasks: unknown[] } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Coordinator returned non-JSON output"); }
  // Persisted fixtures and older planners may still return a bare DAG.
  if (Array.isArray(value)) return { action: "plan", tasks: value };
  const planned = z.object({ action: z.literal("plan"), tasks: z.array(z.unknown()).min(1).max(100) }).strict().safeParse(value);
  if (planned.success) return planned.data;
  const direct = dispatchSchema.safeParse(value);
  if (!direct.success) throw new Error(`Coordinator returned an invalid routing outcome: ${direct.error.issues[0]?.message ?? "schema mismatch"}`);
  return direct.data;
}

export function validateDirectDispatch(route: DirectDispatch, goal: string, bots: CoordinationBot[], requestedBotIds: string[]): CoordinationBot {
  const bot = bots.find((candidate) => candidate.id === route.botId);
  if (!bot) throw new Error(`Direct dispatch names an unavailable bot: ${route.botId}`);
  if (bot.supportsPlanningRequest === false) throw new Error("This agent cannot request structured planning; use a plan instead");
  if (requestedBotIds.length > 1) throw new Error("Multiple requested bots require a plan");
  if (requestedBotIds.length && requestedBotIds[0] !== bot.id) throw new Error("Direct dispatch must use the requested bot");
  if (isRiskSensitiveGoal(`${goal}\n${route.title}\n${route.description}`) || requiresExplicitReview(goal)) {
    throw new Error("Risk-sensitive work or a required review needs a plan");
  }
  return bot;
}
