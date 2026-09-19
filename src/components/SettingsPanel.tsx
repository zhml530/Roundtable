import { ChevronDown, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { agentColorForName } from "../../shared/agent-avatar";
import { ModelPicker } from "./ModelPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { requestNotificationPermission } from "@/lib/notify";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

/** What this bot has spent across its tasks. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">Usage</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          All bots →
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Turns</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Tokens</div>
          <div className="mt-0.5 tabular-nums text-ink" title={`${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`}>
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Cost</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? `Cost ${costCaption(instance?.snapshot.billing)}.` : "This engine doesn't report a price; tokens are counted."}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot workspace</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            placeholder="Private bot workspace — or an absolute path"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"} — start a new task to use the new folder.
        </div>
      )}
    </div>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      setTruncated(result.truncated);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">Memory</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Notes this bot keeps between tasks — plain files you can edit.
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Back
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
            {topic.text}
          </pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={text}
            placeholder="Nothing remembered yet. The bot writes durable notes here — or add your own."
            aria-label="Bot memory"
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                Over the budget — only the top of this file loads each turn.
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Topic files
              </div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function AgentProfilePage({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "color"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "speakReplies"
        | "voice"
        | "approvePeerComms"
        | "modelSelection"
      >
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-14 shrink-0 items-center border-b border-hairline/40 px-6">
        <div>
          <h1 className="text-[15px] font-semibold text-ink">{bot.name}</h1>
          <p className="text-[11px] text-ink-secondary">Agent profile</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 pt-6">
          <BotProfileAvatarCard bot={bot} onPatch={patch} />

          <Field label="Name">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder="Describe what your agent does"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <p className="text-[13px] text-ink-secondary">
            Leave Title and Description blank to use the backend’s native behavior.
            Add either to enable a Roundtable profile with automatic memory and bundled skills.
          </p>
          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder="What this agent is for"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Ask me before contacting other bots
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.approvePeerComms
                  ? "This bot will stop and ask before it reaches out to another bot."
                  : "Let this bot talk to teammates on its own, without a confirmation step."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.approvePeerComms)}
              aria-label="Ask me before contacting other bots"
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot contact other bots" : undefined}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                bot.approvePeerComms ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.approvePeerComms ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <div className="rounded-xl bg-card p-4">
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">Model</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    Which provider and model this bot runs on
                  </div>
                </div>
              }
            />
          </div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Effort</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole thread and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a thread that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                How hard this bot thinks{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
              </div>
              <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                  <button
                    key={level ?? "default"}
                    aria-pressed={bot.modelSelection.effort === level}
                    onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] capitalize",
                      i > 0 && "border-l border-hairline/40",
                      bot.modelSelection.effort === level
                        ? "bg-control text-ink"
                        : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                    )}
                  >
                    {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                    {level === "xhigh" ? "X-High" : (level ?? "Default")}
                  </button>
                ))}
              </div>
            </div>
          )}

          <BotUsageCard bot={bot} />
          <WorkingFolder bot={bot} />

          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <MemoryCard key={bot.id} bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Auto mode</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.autoApprove
                  ? "Keeps going on its own — you'll still be asked about anything destructive, and about questions it asks you."
                  : "Approve each action yourself. Turn on to let this bot keep working without stopping to ask."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.autoApprove)}
              aria-label="Auto mode"
              onClick={() => patch({ autoApprove: !bot.autoApprove })}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.autoApprove ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.autoApprove ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Notifications
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Get notified when this agent finishes or needs input
              </div>
            </div>
            <button
              role="switch"
              aria-checked={bot.notifications}
              aria-label="Agent notifications"
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.notifications ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.notifications ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

export function NewAgentPage() {
  const { state, dispatch } = useStore();
  const firstEngine = state.instances.find((instance) => instance.snapshot.state === "available") ?? state.instances[0];
  const [draft, setDraft] = useState<Bot>(() => ({
    id: "draft-agent",
    threadId: "draft-thread",
    name: "",
    title: "",
    description: "",
    notifications: true,
    color: agentColorForName(""),
    unread: false,
    modelSelection: {
      instanceId: firstEngine?.instanceId ?? "",
      model: firstEngine?.models.default ?? "",
    },
    autoApprove: false,
    approvePeerComms: false,
    messages: [],
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = state.instances.find((instance) => instance.instanceId === draft.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const patchDraft = (patch: Partial<Bot>) => setDraft((current) => ({ ...current, ...patch }));
  const updateDraftName = (name: string) => setDraft((current) => ({
    ...current,
    name,
    color: current.color === agentColorForName(current.name) ? agentColorForName(name) : current.color,
  }));

  useEffect(() => {
    if (draft.modelSelection.instanceId || !firstEngine) return;
    patchDraft({ modelSelection: { instanceId: firstEngine.instanceId, model: firstEngine.models.default } });
  }, [draft.modelSelection.instanceId, firstEngine]);

  const create = async () => {
    if (!draft.name.trim() || !draft.modelSelection.instanceId || !draft.modelSelection.model) return;
    setSaving(true);
    setError(null);
    let createdId: string | null = null;
    try {
      const created: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          title: draft.title.trim(),
          description: draft.description.trim(),
          modelSelection: draft.modelSelection,
        }),
      });
      createdId = created.bot.id;
      const response: { bot: Bot } = await api(`/api/bots/${createdId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name.trim(),
          title: draft.title.trim(),
          description: draft.description.trim(),
          notifications: draft.notifications,
          color: draft.color,
          avatarUrl: draft.avatarUrl,
          avatarCrop: draft.avatarCrop,
          modelSelection: draft.modelSelection,
          cwd: draft.cwd?.trim() || null,
          autoApprove: Boolean(draft.autoApprove),
          approvePeerComms: Boolean(draft.approvePeerComms),
        }),
      });
      const bot = { ...created.bot, ...response.bot, messages: created.bot.messages ?? [] };
      dispatch({ type: "botAdded", bot });
      dispatch({ type: "selectAgentProfile", botId: bot.id });
    } catch (cause) {
      if (createdId) await api(`/api/bots/${createdId}`, { method: "DELETE" }).catch(() => {});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline/40 px-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">New Agent</h1>
          <p className="text-[11px] text-ink-secondary">Configure the complete profile before creating it.</p>
        </div>
        <button type="button" onClick={() => dispatch({ type: "cancelAgentCreate" })} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
        <button type="button" onClick={() => void create()} disabled={saving || !draft.name.trim() || !draft.modelSelection.instanceId || !draft.modelSelection.model} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
          {saving && <Loader2 size={14} className="animate-spin" />} Create Agent
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 pt-6">
          <BotProfileAvatarCard bot={draft} onPatch={patchDraft} />
          <Field label="Name"><input autoFocus className={inputCls} maxLength={BOT_PROFILE_LIMITS.name} value={draft.name} onChange={(event) => updateDraftName(event.target.value)} placeholder="Agent name" /></Field>
          <Field label="Title"><input className={inputCls} maxLength={BOT_PROFILE_LIMITS.title} value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="Describe what your agent does" /></Field>
          <Field label="Description"><textarea className={cn(inputCls, "min-h-[120px] resize-y")} maxLength={BOT_PROFILE_LIMITS.description} value={draft.description} onChange={(event) => patchDraft({ description: event.target.value })} placeholder="What this agent is for" /></Field>
          <div className="rounded-xl bg-card p-4"><ModelPicker bot={draft} contained onChange={(modelSelection) => patchDraft({ modelSelection })} label={<div><div className="text-[15px] font-medium text-ink">Model</div><div className="mt-0.5 text-[13px] text-ink-secondary">Which provider and model this agent runs on</div></div>} /></div>
          {!!engine?.capabilities?.effortLevels?.length && <div className="rounded-xl bg-card p-4"><div className="text-[15px] font-medium text-ink">Effort</div><div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">{([undefined, ...engine.capabilities.effortLevels] as const).map((level, index) => <button key={level ?? "default"} type="button" onClick={() => patchDraft({ modelSelection: { ...draft.modelSelection, effort: level } })} className={cn("flex-1 py-1.5 text-[13px] capitalize", index > 0 && "border-l border-hairline/40", draft.modelSelection.effort === level ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink")}>{level === "xhigh" ? "X-High" : (level ?? "Default")}</button>)}</div></div>}
          <Field label="Working folder"><input className={cn(inputCls, "font-mono text-[12.5px]")} value={draft.cwd ?? ""} onChange={(event) => patchDraft({ cwd: event.target.value })} placeholder="Private agent workspace — or an absolute path" /></Field>
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4"><div><div className="text-[15px] font-medium text-ink">Ask before contacting other agents</div><div className="mt-0.5 text-[13px] text-ink-secondary">Require approval before this agent contacts teammates.</div></div><button role="switch" aria-checked={Boolean(draft.approvePeerComms)} disabled={!draft.approvePeerComms && !canCoordinate} onClick={() => patchDraft({ approvePeerComms: !draft.approvePeerComms })} className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:opacity-40", draft.approvePeerComms ? "bg-accent" : "bg-control")}><span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", draft.approvePeerComms ? "left-[21px]" : "left-[3px]")} /></button></div>
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4"><div><div className="text-[15px] font-medium text-ink">Auto mode</div><div className="mt-0.5 text-[13px] text-ink-secondary">Allow the agent to continue through routine approvals.</div></div><button role="switch" aria-checked={Boolean(draft.autoApprove)} onClick={() => patchDraft({ autoApprove: !draft.autoApprove })} className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full", draft.autoApprove ? "bg-accent" : "bg-control")}><span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", draft.autoApprove ? "left-[21px]" : "left-[3px]")} /></button></div>
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4"><div><div className="text-[15px] font-medium text-ink">Notifications</div><div className="mt-0.5 text-[13px] text-ink-secondary">Notify you when this agent finishes or needs input.</div></div><button role="switch" aria-checked={draft.notifications} onClick={() => patchDraft({ notifications: !draft.notifications })} className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full", draft.notifications ? "bg-accent" : "bg-control")}><span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", draft.notifications ? "left-[21px]" : "left-[3px]")} /></button></div>
          {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">{error}</div>}
        </div>
      </div>
    </main>
  );
}
