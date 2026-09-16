import {
  Bot, CheckCircle2, Hash, MessageCircle, PanelLeftClose, PanelLeftOpen, Settings2,
} from "lucide-react";
import { cn } from "@/lib/cn";

export type WorkspaceView = "chats" | "channels" | "tasks" | "agents";

function NavButton({ active, icon: Icon, label, onClick }: {
  active: boolean;
  icon: typeof MessageCircle;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn("relative flex h-11 w-12 shrink-0 items-center justify-center rounded-lg transition-colors",
        active ? "text-nav-selected" : "text-ink-secondary hover:bg-raised hover:text-ink")}>
      {active && <span aria-hidden="true" className="absolute -left-1 top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-current" />}
      <Icon size={24} />
    </button>
  );
}

export function WorkspaceRail({ view, paneOpen, paneId, onTogglePane, onChangeView, onOpenSettings }: {
  view: WorkspaceView;
  paneOpen: boolean;
  paneId: string;
  onTogglePane: () => void;
  onChangeView: (view: WorkspaceView) => void;
  onOpenSettings: () => void;
}) {
  const toggleLabel = paneOpen ? "Hide navigation pane" : "Show navigation pane";
  const ToggleIcon = paneOpen ? PanelLeftClose : PanelLeftOpen;
  return (
    <nav aria-label="Workspace" className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-hairline/40 px-2 pb-3 pt-3">
      <button type="button" onClick={onTogglePane} title={toggleLabel} aria-label={toggleLabel}
        aria-expanded={paneOpen} aria-controls={paneId}
        className="mb-3 flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised hover:text-ink">
        <ToggleIcon size={22} />
      </button>
      <NavButton active={view === "chats"} icon={MessageCircle} label="Chats" onClick={() => onChangeView("chats")} />
      <NavButton active={view === "channels"} icon={Hash} label="Channels" onClick={() => onChangeView("channels")} />
      <NavButton active={view === "tasks"} icon={CheckCircle2} label="Tasks" onClick={() => onChangeView("tasks")} />
      <NavButton active={view === "agents"} icon={Bot} label="Agents" onClick={() => onChangeView("agents")} />
      <span className="flex-1" />
      <NavButton active={false} icon={Settings2} label="Settings" onClick={onOpenSettings} />
    </nav>
  );
}
