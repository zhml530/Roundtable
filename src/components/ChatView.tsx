import { Component, Fragment, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Bug,
  Clock,
  CircleUserRound,
  FilePenLine,
  Loader2,
  MessageSquareReply,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  ShieldCheck,
  Webhook,
  X,
} from "lucide-react";
import { costCaption, formatTokens, formatUsd, hasFiniteCost, usageChip } from "@/lib/usage";
import {
  useStore,
  useStreaming,
  formatTime,
  messageVersions,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { AgentInitialsAvatar, BotAvatar, STANDARD_BOT_AVATAR_SIZE } from "./Avatar";
import { hasVisibleStreamingText, showWorkingDots } from "@/lib/turn-tail";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { MessageViewport, type MessageViewportItem } from "./MessageViewport";
import { ChatFindBar } from "./ChatFindBar";
import { CopyButton } from "./CopyButton";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { AttachedImageGallery } from "./AttachmentPreview";
import { RenameTitle } from "./RenameTitle";
import { CallOverlay } from "./CallView";
import { BotDelivery } from "./BotDelivery";
import { cn } from "@/lib/cn";
import { useFocusMessage } from "@/lib/focus-message";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitAttachedImages } from "@/lib/composer-attachments";
import { changedFilesFromTurnRows, type ChangedFile } from "@/lib/changed-files";
import {
  commandRunCounts,
  commandRunRows,
  commandRuns,
  currentCommand,
  hasPendingApproval,
  isLiveCommandRun,
  type CommandRunRow,
} from "@/lib/command-runs";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at)} {formatTime(at)}
    </div>
  );
}

/** Live extended thinking: shimmer label + collapsible reasoning text.
 * Ephemeral — rendered only while the turn runs, dropped when it settles. */
function ThinkingStrip({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [text, open]);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] min-w-[200px]">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] hover:bg-raised/40"
        >
          <Brain size={13} className="text-ink-secondary" />
          <span className={cn(active ? "thinking-shimmer animate-shimmer" : "text-ink-secondary")}>
            {active ? "Thinking…" : "Thought process"}
          </span>
          <ChevronDown size={12} className={cn("text-ink-secondary transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div
            ref={tailRef}
            className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-hairline/30 bg-panel px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary"
          >
            {text}
          </div>
        ) : (
          active && (
            <div className="mt-0.5 truncate pl-6 text-[12px] text-ink-secondary/70">
              {text.slice(-120).split("\n").pop()}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> Retry
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="w-full px-1 py-1.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[70%] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  showToolbar = true,
  onCancelEdit,
  onSubmitEdit,
  replyTarget,
  onReply,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  showToolbar?: boolean;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  replyTarget?: Message;
  onReply: () => void;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const webhookView = user ? webhookMessageView(text) : null;
  const attachedImages = user && !webhookView ? splitAttachedImages(text) : null;
  const visibleText = webhookView?.task ?? attachedImages?.display ?? text;
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing && !webhookView) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "flex-wrap justify-start")}>
        {user && <CopyButton text={visibleText} />}
        {!user && showToolbar && (
          <button
            type="button"
            onClick={onReply}
            aria-label="Reply to message"
            className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            title="Reply"
          >
            <MessageSquareReply size={14} />
          </button>
        )}
        {showToolbar && <button
          onClick={() =>
            dispatch({
              type: "updateBot",
              botId: bot.id,
              patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
            })
          }
          aria-label={bot.pinnedMessageId === message.id ? "Unpin message" : "Pin message"}
          className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          title={
            bot.pinnedMessageId === message.id
              ? "Unpin this message"
              : "Pin this message to the top of the thread"
          }
        >
          {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
        </button>}
        <div
          className={cn(
            "rounded-2xl text-[15px] leading-relaxed",
            user ? "max-w-[70%]" : "order-first w-full min-w-0",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : "px-1 py-1.5 text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={bot.name}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>Webhook task</span>
              </div>
              <div className="px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">View event payload</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachedImages && attachedImages.images.length > 0 && (
                <AttachedImageGallery paths={attachedImages.images} />
              )}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                {visibleText}
              </div>
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title="Sent while the bot was working — it saw this before its next step, inside the same turn.">
                  sent mid-turn
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full message
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : (
            <>
              <MessageBoundary fallbackText={text}>
                <ChatMarkdown text={text} />
              </MessageBoundary>
              <BotDelivery botId={bot.id} message={message} />
            </>
          )}
        </div>
        {!user && showToolbar && (
          <div className="flex items-center gap-0.5 self-end pb-0.5">
            <CopyButton text={text} />
          </div>
        )}
        {showToolbar && <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100",
            user ? "order-first mr-1" : "ml-1",
          )}
        >
          {formatTime(message.at)}
        </span>}
      </div>
      {/* busy-gated so a flag stranded by a server restart shows nothing */}
      {user && message.queued && bot.busy && (
        <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-ink-secondary/70">
          <Clock size={11} aria-hidden="true" />
          <span>Queued — sends when this turn finishes</span>
        </div>
      )}
      {showToolbar && versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous version"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next version"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open the conversation with ${comm.withName}`}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <AgentInitialsAvatar name={comm.withName} color={comm.withColor} size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
      </div>
    </div>
  );
}

function approvalOutcome(message: Message): string {
  switch (message.card?.answered) {
    case "allow": return "Allowed once";
    case "deny": return "Denied";
    case "unavailable": return "Not run";
    default: return "Approval requested";
  }
}

function CommandRunGroup({ run, focusedMessageId }: { run: CommandRunRow; focusedMessageId?: string }) {
  const [open, setOpen] = useState(false);
  const counts = commandRunCounts(run.messages);
  const containsFocus = Boolean(focusedMessageId && run.messages.some((message) => message.id === focusedMessageId));
  useEffect(() => {
    if (containsFocus) setOpen(true);
  }, [containsFocus, focusedMessageId]);

  const actionLabel = `${counts.actions} ${counts.actions === 1 ? "action" : "actions"}`;
  const approvalLabel = counts.approvals > 0
    ? ` · ${counts.approvals} ${counts.approvals === 1 ? "approval" : "approvals"}`
    : "";
  const statusCounts = [
    counts.inProgress > 0 && {
      key: "progress",
      label: `${counts.inProgress} in progress`,
      icon: <Loader2 size={13} className="animate-spin" aria-hidden="true" />,
      className: "text-accent",
    },
  ].filter((status): status is Exclude<typeof status, false> => Boolean(status));

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[840px]">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-[13px] text-ink-secondary hover:text-ink"
        >
          <ChevronRight size={14} className={cn("shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-ink">Run command</span>
            <span> · {actionLabel}{approvalLabel}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2" role="status" aria-live="polite">
            {statusCounts.map((status) => (
              <span key={status.key} className={cn("flex items-center gap-1", status.className)}>
                {status.icon}
                {status.label}
              </span>
            ))}
          </span>
        </button>
        {open && (
          <div>
            {run.messages.map((message) => (
              <div key={message.id} className="contents" data-mid={message.id}>
                <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-2 px-3 py-2.5">
                  {message.kind === "options" ? (
                    <ShieldCheck size={14} className={cn("mt-0.5", message.card?.answered === "deny" ? "text-danger" : "text-ink-secondary")} aria-hidden="true" />
                  ) : message.tool?.ok === false ? (
                    <X size={14} className="mt-0.5 text-danger" aria-hidden="true" />
                  ) : message.tool?.ok === undefined ? (
                    <Clock size={14} className="mt-0.5 text-ink-secondary" aria-hidden="true" />
                  ) : (
                    <Check size={14} className="mt-0.5 text-success" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink">
                      {message.kind === "options" ? message.card?.subtitle : message.tool?.name}
                    </div>
                    {message.kind === "options" && message.card?.tool && (
                      <div className="mt-0.5 text-[11px] text-ink-secondary">{message.card.tool}</div>
                    )}
                  </div>
                  <span className="text-[11px] text-ink-secondary">
                    {message.kind === "options" ? approvalOutcome(message) : message.tool?.ok === false ? "Failed" : "Completed"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangedFilesCard({ files }: { files: ChangedFile[] }) {
  if (files.length === 0) return null;
  const label = `${files.length} changed ${files.length === 1 ? "file" : "files"}`;
  return (
    <div className="flex justify-start">
      <section
        className="w-full max-w-[840px] overflow-hidden rounded-xl border border-hairline/40 bg-panel"
        aria-label={label}
      >
        <div className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2.5 text-[13px] text-ink">
          <FilePenLine size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <span className="font-medium">Changed files</span>
          <span className="text-ink-secondary">· {files.length}</span>
        </div>
        <div className="divide-y divide-hairline/30 bg-inset/30">
          {files.map((file) => (
            <div key={`${file.kind}:${file.path}`} className="grid grid-cols-[86px_minmax(0,1fr)] gap-3 px-3 py-2 text-[12.5px]">
              <span className="capitalize text-ink-secondary">{file.kind}</span>
              <span className="truncate font-mono text-ink" title={file.path}>{file.path}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  // markdown re-parses on a deferred value: when tokens arrive faster than
  // the parser keeps up, React lags the parse instead of janking the frame
  const deferred = useDeferredValue(text);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hasRenderedContent, setHasRenderedContent] = useState(false);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const visibleText = content.textContent?.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();
    const visibleElement = content.querySelector("img,svg,pre,table,hr,video,audio");
    setHasRenderedContent(Boolean(visibleText || visibleElement));
  }, [deferred]);
  return (
    <div className={hasRenderedContent ? "flex w-full justify-start" : "hidden"}>
      <div className="w-full min-w-0 px-1 py-1.5 text-[15px] leading-relaxed text-ink">
        <div ref={contentRef}>
          <MessageBoundary fallbackText={deferred}>
            <ChatMarkdown text={deferred} streaming />
          </MessageBoundary>
        </div>
        {hasRenderedContent && (
          <span className="animate-caret ml-0.5 inline-block h-[14px] w-[2px] bg-ink align-middle" />
        )}
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const label = () => `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = label();
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary">{label()}</span>;
}

/** A settled logical transcript row. MessageViewport virtualizes these rows,
 * while this memo boundary keeps expensive Markdown/tool trees isolated from
 * unrelated viewport and streaming-tail updates. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  transcript,
  activeTurnId,
  editingId,
  canRetryLast,
  engine,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
  showFirstDaySeparator = true,
}: {
  bot: Bot;
  messages: Message[];
  /** Full active-branch messages, including virtualized-offscreen rows. */
  transcript: Message[];
  /** Provider turn currently in flight for this thread. */
  activeTurnId?: string;
  editingId: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
  showFirstDaySeparator?: boolean;
}) {
  const { state, dispatch } = useStore();
  const rows = useMemo(() => commandRunRows(messages), [messages]);
  const fallbackActiveTurnId = bot.busy
    ? [...commandRuns(rows)].reverse().find(
        (row) => Boolean(currentCommand(row.messages) || hasPendingApproval(row.messages)),
      )?.turnId
    : undefined;
  const liveTurnId = activeTurnId ?? fallbackActiveTurnId;
  let previousRenderedAt: number | undefined = showFirstDaySeparator ? undefined : messages[0]?.at;
  const renderRow = (entry: CommandRunRow | Extract<ReturnType<typeof commandRunRows>[number], { kind: "message" }>, showToolbar = true) => {
    const m = entry.kind === "message" ? entry.message : entry.messages.at(-1)!;
    if (entry.kind === "command-run") {
      if (bot.busy && isLiveCommandRun(rows, entry, liveTurnId)) {
        const pendingApproval = entry.messages.find(
          (message) =>
            message.kind === "options" &&
            message.card?.requestId &&
            message.card.tool &&
            !message.card.answered &&
            !message.card.dismissed,
        );
        if (pendingApproval) return <ApprovalCard bot={bot} message={pendingApproval} />;
        return <CommandRunGroup run={entry} focusedMessageId={state.focusMessage?.messageId} />;
      }
      return <CommandRunGroup run={entry} focusedMessageId={state.focusMessage?.messageId} />;
    }
    switch (m.kind) {
      case "secret":
        return m.secret ? <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
      case "connector":
        return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
      case "options":
        if (m.card?.requestId && m.card.tool) return <ApprovalCard bot={bot} message={m} />;
        if (shouldHideOnboardingCard(m, transcript)) return null;
        return <OptionCard botId={bot.id} message={m} />;
      case "activity":
        return m.tool?.name.startsWith("error:") ? (
          <ErrorRow
            message={m.tool.name.slice(6).trim()}
            onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
            setupInstance={m.tool.setup ? engine : undefined}
          />
        ) : (
          <ActivityChip message={m} />
        );
      case "screen":
        return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
      default:
        return (
          <Bubble
            bot={bot}
            message={m}
            editing={editingId === m.id}
            showToolbar={showToolbar}
            onCancelEdit={onCancelEdit}
            onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
            replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
            onReply={() => onReply(m)}
          />
        );
    }
  };
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <BotAvatar bot={bot} state="idle" size={64} motion="none" motionKey={0} />
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {bot.description || "Send a message to start the conversation."}
          </div>
        </div>
      )}
      {rows.map((entry) => {
        const firstEntry = entry.kind === "turn" ? entry.rows[0] : entry;
        const firstMessageId = firstEntry.kind === "message"
          ? firstEntry.message.id
          : firstEntry.messages[0].id;
        const lastEntry = entry.kind === "turn" ? entry.rows.at(-1)! : entry;
        const m = lastEntry.kind === "message" ? lastEntry.message : lastEntry.messages.at(-1)!;
        const row = (() => {
          if (entry.kind !== "turn") return renderRow(entry);
          const changedFiles = changedFilesFromTurnRows(entry.rows);
          const changedFilesIndex = changedFiles.length > 0
            ? entry.rows.findLastIndex((turnEntry) => turnEntry.kind === "message" && turnEntry.message.role === "bot" && turnEntry.message.kind === "text")
            : -1;
          const toolbarIndex = bot.busy
            ? -1
            : entry.rows.findLastIndex(
                (turnEntry) =>
                  turnEntry.kind === "message" &&
                  turnEntry.message.role === "bot" &&
                  turnEntry.message.kind === "text",
              );
          return (
            <div className="flex flex-col gap-1">
              {entry.rows.map((turnEntry, index) => {
                return (
                  <Fragment key={turnEntry.kind === "command-run" ? `run:${turnEntry.turnId}:${index}` : turnEntry.message.id}>
                    {index === changedFilesIndex && <ChangedFilesCard files={changedFiles} />}
                    <div
                      data-mid={turnEntry.kind === "message" ? turnEntry.message.id : undefined}
                      className="contents"
                    >
                      {renderRow(turnEntry, index === toolbarIndex)}
                    </div>
                  </Fragment>
                );
              })}
              {changedFilesIndex < 0 && <ChangedFilesCard files={changedFiles} />}
            </div>
          );
        })();
        if (!row) return null;
        const newDay = previousRenderedAt === undefined || new Date(previousRenderedAt).toDateString() !== new Date(m.at).toDateString();
        previousRenderedAt = m.at;
        return (
          <div
            key={entry.kind === "turn"
              ? `turn:${entry.turnId}:${firstMessageId}`
              : entry.kind === "command-run"
                ? `run:${entry.turnId}`
                : m.id}
            className="contents"
            data-mid={entry.kind === "message" ? m.id : undefined}
          >
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

type TranscriptEntry = ReturnType<typeof commandRunRows>[number];

interface TranscriptViewportRow extends MessageViewportItem {
  messages: Message[];
  showDaySeparator: boolean;
}

function messagesForTranscriptEntry(entry: TranscriptEntry): Message[] {
  if (entry.kind === "message") return [entry.message];
  if (entry.kind === "command-run") return entry.messages;
  return entry.rows.flatMap((row) => row.kind === "message" ? [row.message] : row.messages);
}

function transcriptViewportRows(messages: Message[]): TranscriptViewportRow[] {
  let previousAt: number | undefined;
  return commandRunRows(messages).map((entry) => {
    const entryMessages = messagesForTranscriptEntry(entry);
    const first = entryMessages[0];
    const last = entryMessages.at(-1) ?? first;
    const showDaySeparator = previousAt === undefined
      || new Date(previousAt).toDateString() !== new Date(first?.at ?? 0).toDateString();
    previousAt = last?.at;
    const key = entry.kind === "turn"
      ? `turn:${entry.turnId}:${first?.id ?? "empty"}`
      : entry.kind === "command-run"
        ? `run:${entry.turnId}:${first?.id ?? "empty"}`
        : entry.message.id;
    return {
      key,
      messageIds: entryMessages.map((message) => message.id),
      messages: entryMessages,
      showDaySeparator,
    };
  });
}

/** The one pinned message, above the transcript: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const sender =
    pinned.role === "user" ? "You" : (pinned.from?.name ?? bot.name);
  const text = (pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="mx-auto w-full max-w-[900px] px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title="Jump to the pinned message"
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        <button
          onClick={onUnpin}
          aria-label="Unpin message"
          title="Unpin"
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch, loadEarlierMessages } = useStore();

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const visibleStreaming = hasVisibleStreamingText(streaming) ? streaming : undefined;
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const [findOpen, setFindOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => setReplyTo(null), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);

  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const viewportRows = useMemo(() => transcriptViewportRows(messages), [messages]);

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
    },
    [bot.id, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );
  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  useFocusMessage(bot.threadId, messages.length > 0);
  const pageState = state.messagePages[bot.threadId];
  const canLoadEarlier = pageState?.hasMore === true;

  // Every desktop header is a drag region. Non-macOS overlays also need room
  // for their caption buttons.
  const platform = window.ogb?.platform;
  const macInset = platform === "darwin";
  const titleBarOverlay = Boolean(platform && platform !== "darwin");
  const titleBarButtonSize = macInset ? "size-8" : "size-10";
  // SAFETY: Electron supports this nonstandard CSS property, which React's type declarations omit.
  const drag = platform ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  // SAFETY: Electron supports this nonstandard CSS property, which React's type declarations omit.
  const noDrag = platform ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  return (
    <main className="chat-area relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <div
        className={cn(
          // @container so the chips on the right can fold to icon bubbles
          // when the column is narrow (side panel open, small window)
          "@container/chathead flex items-center justify-between px-5",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
          titleBarOverlay ? "h-12 pr-[148px]" : macInset ? "h-12" : "py-3",
        )}
        style={drag}
      >
        <div className={cn("flex min-w-0 items-center gap-2.5 rounded-lg pr-1.5", !macInset && "py-1")}>
          <button
            onClick={() => dispatch({ type: "showAgents", botId: bot.id })}
            className="-ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-raised"
            style={noDrag}
            title="Open agent profile"
            aria-label={`Open ${bot.name}'s profile`}
          >
            <BotAvatar
              bot={bot}
              size={STANDARD_BOT_AVATAR_SIZE}
            />
          </button>
          <span className="min-w-0 truncate select-none text-[15px] font-semibold text-ink">{bot.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1" style={noDrag}>
          <button
            onClick={() => setFindOpen((open) => !open)}
            aria-label="Find in conversation"
            aria-pressed={findOpen}
            className={cn(
              "flex items-center justify-center rounded-md hover:bg-raised",
              titleBarButtonSize,
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Find in conversation (⌘F)"
          >
            <Search size={18} />
          </button>
          <ProfileButton botId={bot.id} compact={macInset} />
          <InspectorButton compact={macInset} open={state.inspectorOpen} onClick={() => dispatch({ type: "toggleInspector" })} />
          <UsageChip bot={bot} compact={macInset} />
        </div>
      </div>

      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Pinned message banner */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={() =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { pinnedMessageId: "" } })
        }
      />

      {/* Virtuoso is the sole owner of transcript measurement and scrolling. */}
      <MessageViewport
        key={transcriptKey}
        ariaLabel={`Conversation with ${bot.name}`}
        items={viewportRows}
        canLoadEarlier={canLoadEarlier}
        loading={pageState?.loading === true}
        error={pageState?.error}
        onLoadEarlier={() => loadEarlierMessages(bot.threadId)}
        focusMessageId={
          state.focusMessage?.threadId === bot.threadId && !state.focusMessage.consumed
            ? state.focusMessage.messageId
            : undefined
        }
        streamRevision={`${visibleStreaming?.length ?? 0}:${reasoning?.length ?? 0}:${bot.busy ? 1 : 0}`}
        renderItem={(row) => (
          <MessagesList
            bot={bot}
            messages={row.messages}
            transcript={messages}
            activeTurnId={stream.activeTurns[bot.threadId]}
            editingId={editingId}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            onReply={setReplyTo}
            showFirstDaySeparator={row.showDaySeparator}
          />
        )}
        footer={(
          <>
            {messages.length === 0 && !bot.busy && (
              <MessagesList
                bot={bot}
                messages={[]}
                transcript={messages}
                activeTurnId={stream.activeTurns[bot.threadId]}
                editingId={editingId}
                canRetryLast={false}
                engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
                onCancelEdit={cancelEdit}
                onSubmitEdit={submitEdit}
                onRegenerate={regenerate}
                onReply={setReplyTo}
              />
            )}
            {provisioning && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                  <Loader2 size={13} className="animate-spin" />
                  Setting up this bot's computer…
                </div>
              </div>
            )}
            {reasoning && bot.busy && <ThinkingStrip text={reasoning} active={!visibleStreaming} />}
            {visibleStreaming && <StreamingBubble text={visibleStreaming} />}
            {showWorkingDots(bot.busy, visibleStreaming, messages.at(-1)) && (
              <div className="flex items-center gap-2.5 px-1 py-2" role="status">
                <span className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                </span>
                <WorkingTimer since={lastUserMessage?.at ?? Date.now()} />
              </div>
            )}
          </>
        )}
      />

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over. ArrowUp-to-edit is
          gated on busy like the pencil button — editing rewinds the thread,
          which a live turn forbids (the server 409s it). */}
      <Composer
        key={bot.id}
        bot={bot}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
      />

    </main>
  );
}

/** What the open task has spent — quiet until the first turn settles.
 * Click opens the bot's settings, where the Usage card has the breakdown. */
function UsageChip({ bot, compact = false }: { bot: Bot; compact?: boolean }) {
  const { state, dispatch } = useStore();
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  const text = usage ? usageChip(usage) : "";
  if (!usage || !text) return null;
  const billing = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const detail = [
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
    `${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`,
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  // folded: one figure — cost when the engine reports one, else tokens
  const short = usage.costUsd !== null ? formatUsd(usage.costUsd) : formatTokens(usage.input + usage.output);
  return (
    <button
      onClick={() => dispatch({ type: "showAgents", botId: bot.id })}
      className={cn(
        "whitespace-nowrap rounded-md px-3 text-[12px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink @max-4xl/chathead:px-2",
        compact ? "h-8" : "h-10",
      )}
      title={detail}
    >
      <span className="@max-4xl/chathead:hidden">{text}</span>
      <span className="hidden @max-4xl/chathead:inline">{short}</span>
    </button>
  );
}

function ProfileButton({ botId, compact = false }: { botId: string; compact?: boolean }) {
  const { dispatch } = useStore();
  return (
    <button
      onClick={() => dispatch({ type: "showAgents", botId })}
      aria-label="Open agent profile"
      className={cn(
        "flex items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
        compact ? "size-8" : "size-10",
      )}
      title="Profile"
    >
      <CircleUserRound size={18} strokeWidth={1.8} />
    </button>
  );
}

function InspectorButton({ open, onClick, compact = false }: { open: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label="Toggle inspector"
      aria-pressed={open}
      className={cn(
        "flex items-center justify-center rounded-md hover:bg-raised",
        compact ? "size-8" : "size-10",
        open ? "text-accent" : "text-ink-secondary hover:text-ink",
      )}
      title="Runtime events and raw protocol for this thread"
    >
      <Bug size={18} />
    </button>
  );
}
