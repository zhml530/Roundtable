import { Bug, ChevronLeft, ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";

export function AppTitleBar({
  bot,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: {
  bot?: Bot;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}) {
  const { state, dispatch } = useStore();
  const platform = window.ogb?.platform;
  if (!platform) return null;

  const isMac = platform === "darwin";
  // SAFETY: Electron supports the documented -webkit-app-region CSS property,
  // but React's CSSProperties declaration intentionally omits vendor window chrome.
  const drag = { WebkitAppRegion: "drag" } as CSSProperties;
  // SAFETY: Same Electron-only property as the drag region above; controls
  // explicitly opt out so their pointer events remain interactive.
  const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;
  return (
    <header
      aria-label="Application title bar"
      className="flex h-10 shrink-0 items-center bg-panel text-ink-secondary"
      style={drag}
    >
      <div className="flex h-full w-[344px] shrink-0 items-center md:w-[352px]">
        {isMac ? (
          <span aria-hidden className="w-[76px] shrink-0" />
        ) : (
          <span className="select-none pl-4 text-[13px] font-semibold text-ink">Roundtable</span>
        )}
        <span className="min-w-2 flex-1" />
        <div className="flex h-full items-center gap-0.5 pr-2" style={noDrag}>
          <button
            type="button"
            onClick={onGoBack}
            disabled={!canGoBack}
            aria-label="Go back"
            title="Go back"
            className="flex size-8 items-center justify-center rounded-md hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            onClick={onGoForward}
            disabled={!canGoForward}
            aria-label="Go forward"
            title="Go forward"
            className="flex size-8 items-center justify-center rounded-md hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <span className="min-w-8 flex-1" />

      <div
        className={cn("flex h-full items-center gap-0.5", isMac ? "pr-2" : "pr-[148px]")}
        style={noDrag}
      >
        {bot?.threadId && (
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleInspector" })}
            aria-label="Toggle inspector"
            aria-pressed={state.inspectorOpen}
            title="Runtime events and raw protocol for this thread"
            className={cn(
              "flex size-8 items-center justify-center rounded-md hover:bg-raised",
              state.inspectorOpen ? "text-accent" : "hover:text-ink",
            )}
          >
            <Bug size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
