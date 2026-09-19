import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Loader2, Menu, RefreshCw } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { unreadConversationCount } from "@/lib/unread";
import { WorkspaceNavigation } from "@/components/WorkspaceNavigation";
import { ChatView } from "@/components/ChatView";
import { AgentChatEmptyState } from "@/components/AgentChatEmptyState";
import { GroupView } from "@/components/GroupView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { AppTitleBar } from "@/components/AppTitleBar";
import { setTitleBarSurface } from "@/lib/skins";

type ShellLocation = {
  activeView: "chat" | "agents" | "team-map" | "routines" | "skill-recorder";
  selectedId: string;
  threadId?: string;
};

function sameShellLocation(left: ShellLocation | undefined, right: ShellLocation): boolean {
  return Boolean(
    left &&
    left.activeView === right.activeView &&
    left.selectedId === right.selectedId &&
    left.threadId === right.threadId
  );
}

const AgentProfilePage = lazy(() =>
  import("@/components/SettingsPanel").then((module) => ({ default: module.AgentProfilePage })),
);
const NewAgentPage = lazy(() =>
  import("@/components/SettingsPanel").then((module) => ({ default: module.NewAgentPage })),
);
const InspectorPanel = lazy(() =>
  import("@/components/InspectorPanel").then((module) => ({ default: module.InspectorPanel })),
);
const SettingsModal = lazy(() =>
  import("@/components/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);
const RoutinesPage = lazy(() =>
  import("@/components/RoutinesPage").then((module) => ({ default: module.RoutinesPage })),
);
const SkillRecorderPage = lazy(() =>
  import("@/components/SkillRecorderPage").then((module) => ({ default: module.SkillRecorderPage })),
);
const TeamMapPage = lazy(() =>
  import("@/components/TeamMapPage").then((module) => ({ default: module.TeamMapPage })),
);

interface LazyErrorState {
  error: Error | null;
}

class LazyErrorBoundary extends Component<
  { children: ReactNode },
  LazyErrorState
> {
  state: LazyErrorState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Deferred UI failed to load", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-32 flex-1 items-center justify-center bg-app p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-hairline/50 bg-panel p-5 text-center text-ink">
          <AlertTriangle size={20} className="text-danger" />
          <p className="text-[13px] text-ink-secondary">This part of Roundtable could not be loaded.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
          >
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      </div>
    );
  }
}

function LazyFallback() {
  return (
    <div className="flex min-h-32 flex-1 items-center justify-center bg-app text-ink-secondary">
      <Loader2 size={18} className="animate-spin" />
      <span className="ml-2 text-[13px]">Loading…</span>
    </div>
  );
}

function Deferred({ children }: { children: ReactNode }) {
  return (
    <LazyErrorBoundary>
      <Suspense fallback={<LazyFallback />}>{children}</Suspense>
    </LazyErrorBoundary>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount = unreadConversationCount(state.bots, state.groups);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const location: ShellLocation = {
    activeView: state.activeView,
    selectedId: state.selectedId,
    threadId: state.activeView === "chat" && bot && !group ? bot.threadId : undefined,
  };
  const [history, setHistory] = useState<{ entries: ShellLocation[]; index: number }>({ entries: [], index: -1 });

  useEffect(() => {
    if (location.activeView === "chat" && !location.selectedId) return;
    setHistory((current) => {
      if (sameShellLocation(current.entries[current.index], location)) return current;
      const entries = [...current.entries.slice(0, current.index + 1), location];
      return { entries: entries.slice(-50), index: Math.min(entries.length - 1, 49) };
    });
  }, [location.activeView, location.selectedId, location.threadId]);

  const navigateHistory = (offset: -1 | 1) => {
    const nextIndex = history.index + offset;
    const target = history.entries[nextIndex];
    if (!target) return;
    setHistory((current) => ({ ...current, index: nextIndex }));
    if (target.activeView === "chat") {
      dispatch({ type: "select", id: target.selectedId });
      const targetBot = state.bots.find((candidate) => candidate.id === target.selectedId);
      if (target.threadId && targetBot && targetBot.threadId !== target.threadId) {
        dispatch({ type: "switchTask", botId: targetBot.id, threadId: target.threadId });
      }
    } else if (target.activeView === "agents") {
      dispatch({ type: "showAgents", botId: target.selectedId });
    } else if (target.activeView === "team-map") {
      dispatch({ type: "showTeamMap" });
    } else if (target.activeView === "routines") {
      dispatch({ type: "showRoutines" });
    } else {
      dispatch({ type: "showSkillRecorder" });
    }
  };

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((instance) => instance.refreshing) &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new Agent · ⌘1–9 jump to Agent · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "startAgentCreate" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView]);

  useLayoutEffect(() => {
    const backdropOpacity = state.appSettingsOpen ? 0.5 : 0;
    setTitleBarSurface("panel", backdropOpacity);
  }, [state.appSettingsOpen]);

  return (
    <div className="flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <AppTitleBar
        bot={state.activeView === "chat" && !group ? bot : undefined}
        canGoBack={history.index > 0}
        canGoForward={history.index >= 0 && history.index < history.entries.length - 1}
        onGoBack={() => navigateHistory(-1)}
        onGoForward={() => navigateHistory(1)}
      />
      <div className="relative flex min-h-0 flex-1 bg-panel">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open bot list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <WorkspaceNavigation
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "agents" ? (
        state.agentCreateOpen ? (
          <Deferred><NewAgentPage /></Deferred>
        ) : bot ? (
          <Deferred><AgentProfilePage bot={bot} /></Deferred>
        ) : (
          <main className="flex min-w-0 flex-1 items-center justify-center bg-app text-[13px] text-ink-secondary">Create an Agent to get started.</main>
        )
      ) : state.activeView === "team-map" ? (
        <Deferred><TeamMapPage /></Deferred>
      ) : state.activeView === "routines" ? (
        <Deferred><RoutinesPage /></Deferred>
      ) : state.activeView === "skill-recorder" ? (
        <Deferred><SkillRecorderPage /></Deferred>
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        bot.threadId ? <ChatView bot={bot} /> : <AgentChatEmptyState name={bot.name} onNewChat={() => {
          dispatch({ type: "newTask", botId: bot.id });
        }} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-chat-background text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.inspectorOpen && bot?.threadId && <Deferred><InspectorPanel bot={bot} /></Deferred>}
      {state.appSettingsOpen && <Deferred><SettingsModal /></Deferred>}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPalette />
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
