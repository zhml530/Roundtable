import type { CoordinationTask } from "@/state/store";

export interface DagNodeLayout {
  task: CoordinationTask;
  depth: number;
  x: number;
  y: number;
}

export interface CoordinationDagLayout {
  nodes: DagNodeLayout[];
  width: number;
  height: number;
}

const CARD_W = 196;
const CARD_H = 94;
const GAP_X = 54;
const GAP_Y = 24;

export function layoutCoordinationDag(tasks: CoordinationTask[]): CoordinationDagLayout {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    const depth = task?.dependsOn.length ? 1 + Math.max(0, ...task.dependsOn.filter((dep) => byId.has(dep)).map(depthOf)) : 0;
    visiting.delete(id);
    memo.set(id, depth);
    return depth;
  };
  const rows = new Map<number, number>();
  const nodes = tasks.map((task) => {
    const depth = depthOf(task.id);
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    return { task, depth, x: 16 + depth * (CARD_W + GAP_X), y: 16 + row * (CARD_H + GAP_Y) };
  });
  const maxDepth = Math.max(0, ...nodes.map((node) => node.depth));
  const maxRows = Math.max(1, ...rows.values());
  return { nodes, width: 32 + (maxDepth + 1) * CARD_W + maxDepth * GAP_X, height: 32 + maxRows * CARD_H + (maxRows - 1) * GAP_Y };
}

export const DAG_CARD_WIDTH = CARD_W;
export const DAG_CARD_HEIGHT = CARD_H;
