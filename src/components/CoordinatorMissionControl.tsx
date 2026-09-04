import { useMemo, useState } from "react";
import { Ban, ChevronDown, ChevronUp, CirclePause, CirclePlay, ExternalLink, GitBranch, Loader2, RotateCcw, Sparkles } from "lucide-react";

import { api, useStore, type CoordinationRun, type CoordinationTask, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { DAG_CARD_HEIGHT, DAG_CARD_WIDTH, layoutCoordinationDag } from "@/lib/coordination-dag";

const STATUS_STYLE = {
  pending: "border-hairline/50 bg-panel",
  ready: "border-sky-500/50 bg-sky-500/10",
  running: "border-accent/60 bg-accent/10 shadow-md shadow-accent/10",
  completed: "border-emerald-500/50 bg-emerald-500/10",
  failed: "border-danger/60 bg-danger/10",
  blocked: "border-amber-500/50 bg-amber-500/10",
  cancelled: "border-hairline/40 bg-inset opacity-70",
} satisfies Record<CoordinationTask["status"], string>;

const STATUS_DOT = {
  pending: "bg-ink-secondary/40", ready: "bg-sky-500", running: "bg-accent animate-pulse",
  completed: "bg-emerald-500", failed: "bg-danger", blocked: "bg-amber-500", cancelled: "bg-ink-secondary/30",
} satisfies Record<CoordinationTask["status"], string>;

function elapsed(run: CoordinationRun): string {
  const end = run.finishedAt ?? Date.now();
  const start = run.startedAt ?? run.createdAt;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function CoordinatorMissionControl({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = group.coordination;
  const layout = useMemo(() => layoutCoordinationDag(run?.tasks.filter((task) => task.id !== "planning") ?? []), [run?.tasks]);

  const update = async (action: "pause" | "resume" | "cancel" | "retry") => {
    setBusy(action);
    setError(null);
    try {
      const result = await api(`/api/groups/${group.id}/coordination/${action}`, {
        method: "POST",
        body: "{}",
      });
      if (result.run) dispatch({ type: "groupPatched", group: { id: group.id, coordination: result.run } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const openTask = async (task: CoordinationTask) => {
    if (!task.threadId) return;
    setError(null);
    try {
      const result = await api(`/api/bots/${task.botId}/tasks/${task.threadId}`, { method: "POST" });
      if (result.bot) dispatch({ type: "taskSwitched", bot: result.bot });
      dispatch({ type: "select", id: task.botId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!run) {
    return (
      <section className="mx-auto mb-2 w-full max-w-[900px] px-5" aria-label="Coordinator channel">
        <div className="rounded-2xl border border-accent/25 bg-gradient-to-r from-accent/[0.09] to-purple-500/[0.06] p-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-accent"><Sparkles size={14} /> Coordinator Channel</div>
          <div className="mt-1.5 text-[12.5px] text-ink">Send a goal in the composer. Coordinator will choose the smallest safe DAG and assign the necessary Bots.</div>
          <div className="mt-1 text-[11.5px] text-ink-secondary">Use @Bot as an assignment constraint, or @everyone to include every channel member.</div>
          {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        </div>
      </section>
    );
  }

  const active = ["planning", "validating", "running", "paused", "reviewing"].includes(run.status);
  const needsInput = (task: CoordinationTask) => task.status === "running" && !!task.threadId
    && state.bots.some((bot) => bot.id === task.botId && bot.activity === "waiting-on-you");
  const waitingTasks = run.tasks.filter(needsInput);
  const taskLabel = (task: CoordinationTask) => {
    if (needsInput(task)) return "Needs your input in Channel";
    if (task.status === "pending") return "Waiting for dependencies";
    if (task.status === "ready") return run.status === "paused" ? "Paused" : "Waiting for a slot";
    if (task.status === "running" && !task.threadId) return "Waiting for Bot / starting";
    return task.status;
  };
  return (
    <section className="mx-auto mb-2 w-full max-w-[900px] px-5" aria-label="DAG Mission Control">
      <div className="overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-center gap-3 border-b border-hairline/40 px-3 py-2.5">
          <GitBranch size={15} className="text-accent" />
          <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded((value) => !value)}>
            <div className="flex items-center gap-2"><span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">Mission Control</span><span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-semibold", run.status === "completed" ? "bg-emerald-500/15 text-emerald-500" : run.status === "failed" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent")}>{run.status}</span></div>
            <div className="mt-0.5 truncate text-[12.5px] text-ink">{run.goal}</div>
          </button>
          <span className="text-[11.5px] tabular-nums text-ink-secondary">{elapsed(run)}</span>
          {active && run.status !== "paused" && <button title="Pause new task dispatch" onClick={() => void update("pause")} disabled={busy !== null} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><CirclePause size={16} /></button>}
          {run.status === "paused" && <button title="Resume" onClick={() => void update("resume")} disabled={busy !== null} className="rounded-lg p-1.5 text-accent hover:bg-raised"><CirclePlay size={16} /></button>}
          {active && <button title="Cancel run" onClick={() => void update("cancel")} disabled={busy !== null} className="rounded-lg p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger"><Ban size={16} /></button>}
          {["planning_blocked", "failed", "cancelled"].includes(run.status) && <button title="Retry run" onClick={() => void update("retry")} disabled={busy !== null} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><RotateCcw size={16} /></button>}
          <button onClick={() => setExpanded((value) => !value)} className="rounded-lg p-1 text-ink-secondary hover:bg-raised">{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
        </div>

        {expanded && <>
          {run.reviewStatus && <div className="border-b border-hairline/40 px-3 py-2 text-[12px]">
            Execution: {run.status === "completed" ? "finished" : run.status} · Review: {run.reviewStatus.replaceAll("_", " ")}
          </div>}
          {waitingTasks.length > 0 && <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-ink">
            <div>Waiting for your input. Answer the approval requests or questions in this Channel.</div>
            <div className="mt-1 flex flex-wrap gap-2">{waitingTasks.map((task) => <button key={task.id} onClick={() => void openTask(task)} className="rounded border border-amber-500/40 px-2 py-1 hover:bg-amber-500/10">Open {task.botName} task <ExternalLink size={11} className="inline" /></button>)}</div>
          </div>}
          <div className="grid gap-px border-b border-hairline/40 bg-hairline/30 sm:grid-cols-2">
            <div className="bg-card px-3 py-2"><div className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-secondary">Coordinator model</div><div className="truncate text-[12px] text-ink">{run.coordinatorSnapshot.actualModel?.model ?? run.coordinatorSnapshot.requestedModel.model}</div><div className="truncate text-[10.5px] text-ink-secondary">{run.coordinatorSnapshot.actualModel?.instanceId ?? run.coordinatorSnapshot.requestedModel.instanceId} · {run.coordinatorSnapshot.promptVersion}</div></div>
            <div className="bg-card px-3 py-2"><div className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-secondary">Execution</div><div className="truncate text-[12px] text-ink">{run.tasks.filter((task) => task.status === "running").length}/{run.policySnapshot.maxConcurrency} slots in use · {run.policySnapshot.maxFixCycles} fix cycles</div><div className="truncate text-[10.5px] text-ink-secondary">Independent tasks overlap; dependencies wait</div></div>
          </div>
          {run.requestedBotIds.length > 0 && <div className="border-b border-hairline/40 px-3 py-2 text-[11.5px]" aria-label="Mentioned Bot assignments">
            <div className="font-semibold text-ink-secondary">Mentioned Bots · {run.requestedBotIds.filter((id) => run.tasks.some((task) => task.botId === id)).length}/{run.requestedBotIds.length} assigned</div>
            {run.requestedBotIds.map((id) => {
              const tasks = run.tasks.filter((task) => task.botId === id);
              const name = run.requestedBots?.find((bot) => bot.id === id)?.name ?? tasks[0]?.botName ?? id;
              return <div key={id} className="mt-1 text-ink"><span className="font-medium">{name}</span>: {tasks.length ? tasks.map((task) => `${task.title} (${taskLabel(task)})`).join(" · ") : run.status === "planning_blocked" ? "Assignment missing — revise the plan" : run.status === "cancelled" || run.status === "failed" ? "Not assigned" : "Awaiting Coordinator plan"}</div>;
            })}
          </div>}
          <div className="max-h-[330px] overflow-auto bg-inset/40">
            {(run.status === "planning" || run.status === "validating") && layout.nodes.length === 0 ? <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" /> Coordinator Intelligence is {run.status === "validating" ? "being validated" : "generating the DAG"}…</div> :
            <div className="relative" style={{ width: layout.width, height: layout.height }}>
              <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
                <defs><marker id={`dag-arrow-${run.id}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" className="fill-ink-secondary/40" /></marker></defs>
                {layout.nodes.flatMap((node) => node.task.dependsOn.map((dependency) => {
                  const source = layout.nodes.find((candidate) => candidate.task.id === dependency);
                  if (!source) return null;
                  const x1 = source.x + DAG_CARD_WIDTH, y1 = source.y + DAG_CARD_HEIGHT / 2, x2 = node.x, y2 = node.y + DAG_CARD_HEIGHT / 2;
                  return <path key={`${dependency}-${node.task.id}`} d={`M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2} ${y2}`} fill="none" className="stroke-ink-secondary/35" strokeWidth="1.5" markerEnd={`url(#dag-arrow-${run.id})`} />;
                }))}
              </svg>
              {layout.nodes.map(({ task, x, y }) => <button key={task.id} type="button" disabled={!task.threadId} onClick={() => void openTask(task)} title={`${taskLabel(task)} — ${task.description}`} className={cn("absolute rounded-xl border p-2.5 text-left transition hover:brightness-110 disabled:cursor-default", STATUS_STYLE[task.status])} style={{ left: x, top: y, width: DAG_CARD_WIDTH, height: DAG_CARD_HEIGHT }}>
                <div className="flex items-center gap-1.5"><span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[task.status])} /><span className="truncate text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">{task.role} · {task.botName}</span>{task.threadId && <ExternalLink size={10} className="ml-auto shrink-0 text-ink-secondary" />}</div>
                <div className="mt-1 line-clamp-2 text-[12px] font-medium leading-snug text-ink">{task.title}</div>
                <div className={cn("mt-1 text-[10px]", needsInput(task) ? "font-semibold text-amber-600 dark:text-amber-400" : "text-ink-secondary")}>{taskLabel(task)}</div>
                {task.fixCycle && <span className="absolute bottom-1.5 right-2 text-[9px] text-amber-500">fix {task.fixCycle}</span>}
              </button>)}
            </div>}
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-[11px] text-ink-secondary"><span>{run.tasks.filter((task) => task.status === "completed").length}/{run.tasks.filter((task) => task.id !== "planning").length} tasks complete · {run.fixCycles} fix cycles</span><span className="truncate">{run.events.at(-1)?.message}</span></div>
        </>}
        {(error || run.error) && <div className="border-t border-danger/20 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error ?? run.error}</div>}
      </div>
    </section>
  );
}
