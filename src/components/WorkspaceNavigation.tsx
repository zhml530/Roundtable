import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot, CheckCircle2, Hash, MessageCircle,
  Plus, Search, Settings2, Users, X,
} from "lucide-react";
import { formatTime, useStore, type Bot as Agent, type Group } from "@/state/store";
import { BotAvatar, STANDARD_BOT_AVATAR_SIZE } from "./Avatar";
import { cn } from "@/lib/cn";
import { matchesChatFilter, type ChatFilter } from "@/lib/chat-filter";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { BotPickerList } from "./BotPickerList";
import { track } from "@/lib/analytics";
import { useConversationMenus } from "./useConversationMenus";
import type { conversationMenuBindings } from "@/lib/conversation-menu";
import { ChannelTree } from "./ChannelTree";

type WorkspaceView = "chats" | "channels" | "tasks" | "agents";
const CHAT_FILTERS = ["all", "channels", "direct", "unread"] satisfies readonly ChatFilter[];

interface ChatRow {
  id: string;
  threadId: string;
  title: string;
  owner: string;
  kind: "channel" | "direct";
  at: number;
  preview: string;
  unread: boolean;
  agent?: Agent;
  group?: Group;
}

function messagePreview(messages: Agent["messages"]) {
  const message = messages.at(-1);
  if (!message) return { at: 0, text: "No messages yet" };
  if (message.kind === "activity") return { at: message.at, text: message.tool?.name ?? "Working…" };
  return { at: message.at, text: message.role === "user" ? `You: ${message.text ?? ""}` : message.text ?? "" };
}

function directChats(agent: Agent): ChatRow[] {
  return (agent.tasks ?? []).map((task) => {
    const active = task.threadId === agent.threadId;
    const messages = active ? agent.messages : [];
    const preview = messagePreview(messages);
    return {
      id: `${agent.id}:${task.threadId}`,
      threadId: task.threadId,
      title: task.title || "New chat",
      owner: agent.name,
      kind: "direct",
      // Only the active thread has hydrated messages. Sorting on its message
      // timestamp would move two rows every time the user switches chats.
      at: task.createdAt,
      preview: active && agent.busy ? "Working…" : preview.text,
      unread: active && agent.unread,
      agent,
    };
  });
}

function channelChat(group: Group): ChatRow {
  const preview = messagePreview(group.messages);
  return {
    id: group.id,
    threadId: group.threadId,
    title: group.topicName ?? group.name,
    owner: group.name,
    kind: "channel",
    at: preview.at || group.createdAt,
    preview: group.busyBotId ? "Coordinator is working…" : preview.text,
    unread: group.unread,
    group,
  };
}

function NavButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof MessageCircle; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className={cn("flex size-11 items-center justify-center rounded-xl transition-colors", active ? "bg-accent text-white" : "text-ink-secondary hover:bg-raised hover:text-ink")}>
      <Icon size={19} />
    </button>
  );
}

function ConversationRow({ row, selected, onOpen, menuBindings }: {
  row: ChatRow;
  selected: boolean;
  onOpen: () => void;
  menuBindings: ReturnType<typeof conversationMenuBindings>;
}) {
  const title = row.kind === "channel" && !row.group?.topicName ? row.preview : row.title;
  const subtitle = row.kind === "channel" ? `# ${row.owner}` : row.owner;
  return (
    <button
      type="button"
      onClick={onOpen}
      {...menuBindings}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left",
        selected ? "bg-accent/10" : "hover:bg-raised/70",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{title}</span>
          <span className="ml-auto shrink-0 text-[11px] text-ink-secondary">{row.at ? formatTime(row.at) : ""}</span>
        </span>
        <span className="block truncate text-[12px] text-ink-secondary">{subtitle}</span>
      </span>
      {row.unread && <span className="mt-2 size-2 shrink-0 rounded-full bg-accent" />}
    </button>
  );
}

function NewChatMenu({ agents, open, onOpenChange, onSelect, noDragStyle }: {
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (agent: Agent) => void;
  noDragStyle?: React.CSSProperties;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onOpenChange(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("mousedown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onOpenChange, open]);

  return (
    <div ref={menuRef} className="relative" style={noDragStyle}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        title="New Chat"
        aria-label="New Chat"
      >
        <Plus size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Choose an agent for the new chat"
          className="absolute right-0 top-full z-50 mt-1 w-[300px] overflow-hidden rounded-xl border border-hairline/60 bg-card p-1.5 shadow-2xl shadow-black/60"
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">New chat with</p>
          <div className="max-h-[min(360px,55vh)] overflow-y-auto">
            {agents.map((agent, index) => (
              <button
                key={agent.id}
                type="button"
                role="menuitem"
                autoFocus={index === 0}
                onClick={() => onSelect(agent)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-raised"
              >
                <BotAvatar bot={agent} state="happy" size={28} animated={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{agent.name}</span>
                  <span className="block truncate text-[11px] text-ink-secondary">{agent.title || "Agent"}</span>
                </span>
              </button>
            ))}
            {agents.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-ink-secondary">No agents available</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const agents = state.bots.filter((agent) => !agent.hidden);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const toggleAgent = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const createChannel = () => {
    if (picked.size === 0) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: context.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(context.trim()) });
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby="new-channel-title" className="w-full max-w-[360px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl shadow-black/60">
        <header className="mb-3 flex items-center gap-3">
          <h2 id="new-channel-title" className="min-w-0 flex-1 text-[15px] font-semibold text-ink">New Channel</h2>
          <button type="button" onClick={onClose} aria-label="Close New Channel dialog" title="Close" className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={17} />
          </button>
        </header>
        <input autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Channel name" className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-secondary" />
        <input maxLength={60} value={context} onChange={(event) => setContext(event.target.value)} placeholder="Context (optional)" aria-label="Channel context" className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-secondary" />
        <BotPickerList bots={agents} picked={picked} onToggle={toggleAgent} emptyHint="Create an agent first — channels need at least one agent." />
        <button type="button" onClick={createChannel} disabled={picked.size === 0} className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40">
          Create Channel{picked.size > 0 ? ` · ${picked.size} ${picked.size === 1 ? "agent" : "agents"}` : ""}
        </button>
      </section>
    </div>,
    document.body,
  );
}

/** Conversation-first navigation. It deliberately maps legacy `Task` records
 * to the user-facing Chat term: each already has its own transcript and native
 * provider cursor, so no history or session migration is required. */
export function WorkspaceNavigation({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const [view, setView] = useState<WorkspaceView>("chats");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [query, setQuery] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menus = useConversationMenus({
    onTopicCreated: (topic) => {
      setExpanded((value) => ({ ...value, [topic.channelId ?? topic.id]: true }));
      onClose();
    },
  });
  const chatMenuBindings = (chat: ChatRow) => menus.bindings(chat.agent
    ? { botId: chat.agent.id, threadId: chat.threadId }
    : { groupId: chat.id });

  useEffect(() => {
    if (state.activeView === "agents") setView("agents");
  }, [state.activeView]);

  const chats = useMemo(() => {
    const workerThreads = new Set(state.groups.flatMap((group) => Object.values(group.memberSessions ?? {})));
    return [
      ...state.groups.map(channelChat),
      ...state.bots.filter((agent) => !agent.hidden).flatMap(directChats).filter((chat) => !workerThreads.has(chat.threadId)),
    ].sort((a, b) => Number(b.agent?.pinned ?? false) - Number(a.agent?.pinned ?? false) || b.at - a.at);
  }, [state.bots, state.groups]);
  const term = query.trim().toLowerCase();
  const visibleChats = chats.filter((chat) =>
    matchesChatFilter(chat, filter) &&
    (!term || `${chat.title} ${chat.owner} ${chat.preview}`.toLowerCase().includes(term)),
  );
  const selectedGroup = state.groups.find((group) => group.id === state.selectedId);
  const selectedAgent = selectedGroup
    ? undefined
    : state.bots.find((agent) => agent.id === state.selectedId);
  const persistedSelectedChatId = selectedGroup?.id
    ?? (selectedAgent?.threadId ? `${selectedAgent.id}:${selectedAgent.threadId}` : undefined);
  const selectedChatId = pendingChatId ?? persistedSelectedChatId;
  useEffect(() => {
    if (pendingChatId && (pendingChatId === persistedSelectedChatId || !chats.some((chat) => chat.id === pendingChatId))) setPendingChatId(null);
  }, [chats, pendingChatId, persistedSelectedChatId]);
  const openChat = (chat: ChatRow) => {
    menus.close();
    setPendingChatId(chat.id);
    if (chat.agent) {
      dispatch({ type: "select", id: chat.agent.id });
      if (chat.threadId !== chat.agent.threadId) dispatch({ type: "switchTask", botId: chat.agent.id, threadId: chat.threadId });
    } else if (chat.group) dispatch({ type: "select", id: chat.group.id });
    onClose();
  };
  const createDirectChat = (agent: Agent) => {
    dispatch({ type: "select", id: agent.id });
    dispatch({ type: "newTask", botId: agent.id });
    setNewChatOpen(false);
    setView("chats");
  };
  const desktop = capabilities.host.label !== "Browser";
  // SAFETY: Electron implements this CSS property although React's declarations omit it.
  const dragStyle = desktop ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  // SAFETY: Interactive descendants of an Electron drag region must opt out explicitly.
  const noDragStyle = desktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;
  const changeView = (nextView: WorkspaceView) => {
    menus.close();
    window.getSelection()?.removeAllRanges();
    setNewChatOpen(false);
    setNewChannelOpen(false);
    if (nextView === "agents") dispatch({ type: "showAgents" });
    else if (state.activeView === "agents" && state.selectedId) dispatch({ type: "select", id: state.selectedId });
    setView(nextView);
  };

  const title = view === "chats" ? "Chats" : view === "channels" ? "Channels" : view === "tasks" ? "Tasks" : "Agents";
  return (
    <aside className={cn("z-40 flex h-full shrink-0 select-none border-r border-hairline/50 bg-panel max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-[344px] max-md:shadow-2xl", open ? "max-md:translate-x-0" : "max-md:-translate-x-full", "transition-transform md:w-[352px]") }>
      <nav className="flex w-16 flex-col items-center gap-2 border-r border-hairline/40 px-2 pb-3 pt-3">
        <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white" style={dragStyle}>R</div>
        <NavButton active={view === "chats"} icon={MessageCircle} label="Chats" onClick={() => changeView("chats")} />
        <NavButton active={view === "channels"} icon={Hash} label="Channels" onClick={() => changeView("channels")} />
        <NavButton active={view === "tasks"} icon={CheckCircle2} label="Tasks" onClick={() => changeView("tasks")} />
        <NavButton active={view === "agents"} icon={Bot} label="Agents" onClick={() => changeView("agents")} />
        <span className="flex-1" />
        <NavButton active={false} icon={Settings2} label="Settings" onClick={() => dispatch({ type: "toggleAppSettings" })} />
      </nav>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 px-4" style={dragStyle}>
          <h1 className="text-[15px] font-semibold text-ink">{title}</h1>
          <span className="flex-1" />
          {view === "chats" && (
            <NewChatMenu
              agents={state.bots.filter((agent) => !agent.hidden)}
              open={newChatOpen}
              onOpenChange={setNewChatOpen}
              onSelect={createDirectChat}
              noDragStyle={noDragStyle}
            />
          )}
          {view === "agents" && (
            <button type="button" onClick={() => dispatch({ type: "startAgentCreate" })} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" style={noDragStyle} title="New Agent" aria-label="New Agent">
              <Plus size={18} />
            </button>
          )}
          {view === "channels" && (
            <button type="button" onClick={() => setNewChannelOpen(true)} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" style={noDragStyle} title="New Channel" aria-label="New Channel">
              <Plus size={18} />
            </button>
          )}
        </header>
        {(view === "chats" || view === "agents") && <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-2.5 py-2 text-ink-secondary"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "chats" ? "Search chats" : "Search agents"} className="min-w-0 flex-1 select-text bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary" /></label>}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {view === "chats" && <>
            <div className="mb-2 flex gap-1 px-1">{CHAT_FILTERS.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={cn("rounded-md px-2 py-1 text-[11px] capitalize", filter === item ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}>{item}</button>)}</div>
            {visibleChats.map((chat) => <ConversationRow key={chat.id} row={chat} selected={chat.id === selectedChatId} onOpen={() => openChat(chat)} menuBindings={chatMenuBindings(chat)} />)}
            {visibleChats.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-ink-secondary">No matching chats</p>}
          </>}
          {view === "channels" && <ChannelTree groups={state.groups} expanded={expanded} selectedId={state.selectedId}
            onToggle={(channelId, isOpen) => setExpanded((value) => ({ ...value, [channelId]: isOpen }))}
            onOpen={(topic) => openChat(channelChat(topic))} onNewTopic={menus.openNewTopic}
            bindings={(groupId) => menus.bindings({ groupId })} />}
          {view === "tasks" && <>{chats.filter((chat) => chat.kind === "direct").map((chat) => <button key={chat.id} type="button" {...chatMenuBindings(chat)} onClick={() => openChat(chat)} className="mb-1 w-full rounded-lg border border-hairline/35 px-3 py-2 text-left hover:bg-raised"><span className="flex items-center gap-2 text-[13px] text-ink"><CheckCircle2 size={15} className={chat.agent?.busy ? "text-accent" : "text-ink-secondary"} />{chat.title}</span><span className="ml-6 block truncate text-[11px] text-ink-secondary">{chat.owner} · {chat.agent?.busy ? "In progress" : "Conversation"}</span></button>)}{state.groups.flatMap((group) => group.coordination?.tasks ?? []).map((task) => <button key={task.id} type="button" onClick={() => dispatch({ type: "select", id: state.groups.find((group) => group.coordination?.tasks.some((candidate) => candidate.id === task.id))!.id })} className="mb-1 w-full rounded-lg border border-hairline/35 px-3 py-2 text-left hover:bg-raised"><span className="text-[13px] text-ink">{task.title}</span><span className="block text-[11px] text-ink-secondary">{task.botName} · {task.status}</span></button>)}</>}
          {view === "agents" && state.bots.filter((agent) => !agent.hidden && (!term || `${agent.name} ${agent.title} ${agent.description}`.toLowerCase().includes(term))).map((agent) => <div key={agent.id} className={cn("mb-2 rounded-xl border p-3", state.activeView === "agents" && state.selectedId === agent.id && !state.agentCreateOpen ? "border-accent/50 bg-accent/5" : "border-hairline/50 bg-card")}><button type="button" {...menus.bindings({ botId: agent.id })} onClick={() => dispatch({ type: "selectAgentProfile", botId: agent.id })} className="flex w-full items-center gap-2 text-left"><BotAvatar bot={agent} size={STANDARD_BOT_AVATAR_SIZE} /><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">{agent.name}</span><span className="block truncate text-[11px] text-ink-secondary">{agent.title || "Agent"}</span></span><span className="size-2 rounded-full bg-success" title="Connected" /></button><button type="button" onClick={() => createDirectChat(agent)} className="mt-2 w-full rounded-md bg-raised px-2 py-1.5 text-[12px] text-ink hover:bg-raised-hover">New Chat</button></div>)}
        </div>
        {menus.footer}
        <button type="button" onClick={() => dispatch({ type: "toggleAppSettings" })} className="mx-3 mb-3 flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><Users size={15} />Workspace settings</button>
      </section>
      {newChannelOpen && <NewChannelDialog onClose={() => setNewChannelOpen(false)} />}
      {menus.overlays}
    </aside>
  );
}
