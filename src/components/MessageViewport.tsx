import { forwardRef, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  MESSAGE_VIEWPORT_INDEX_BASE,
  reconcileFirstItemIndex,
  viewportItemIndexForMessage,
  type KeyedViewportItem,
} from "@/lib/message-viewport";

export type MessageViewportItem = KeyedViewportItem;

interface MessageViewportContext {
  empty: boolean;
  error?: string;
  footer?: ReactNode;
  loading: boolean;
  onRetry: () => void;
}

const ViewportList = forwardRef<HTMLDivElement, ComponentProps<"div">>(function ViewportList(
  { children, className: _className, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className="mx-auto flex w-full max-w-[900px] flex-col gap-3"
    >
      {children}
    </div>
  );
});

function ViewportHeader({ context }: { context: MessageViewportContext }) {
  if (context.loading) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-2 text-[12.5px] text-ink-secondary"
        role="status"
        aria-live="polite"
      >
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Loading earlier messages…
      </div>
    );
  }
  if (context.error) {
    return (
      <div className="flex justify-center py-2">
        <button
          type="button"
          onClick={context.onRetry}
          className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Retry loading earlier messages
        </button>
      </div>
    );
  }
  return null;
}

function ViewportFooter({ context }: { context: MessageViewportContext }) {
  if (context.empty) return null;
  return context.footer
    ? <div className="flex flex-col gap-3 pt-3 pb-14">{context.footer}</div>
    : <div className="h-14" aria-hidden="true" />;
}

function ViewportEmpty({ context }: { context: MessageViewportContext }) {
  return context.footer
    ? <div className="mx-auto flex h-full w-full max-w-[900px] flex-col gap-3 pb-14">{context.footer}</div>
    : null;
}

const VIEWPORT_COMPONENTS = {
  List: ViewportList,
  Header: ViewportHeader,
  Footer: ViewportFooter,
  EmptyPlaceholder: ViewportEmpty,
};

export function MessageViewport<T extends MessageViewportItem>({
  ariaLabel,
  canLoadEarlier,
  error,
  focusMessageId,
  footer,
  items,
  loading,
  onLoadEarlier,
  renderItem,
  streamRevision,
}: {
  ariaLabel: string;
  canLoadEarlier: boolean;
  error?: string;
  focusMessageId?: string;
  footer?: ReactNode;
  items: readonly T[];
  loading: boolean;
  onLoadEarlier: () => void | Promise<void>;
  renderItem: (item: T) => ReactNode;
  /** Changes whenever the final row/footer grows without changing item count. */
  streamRevision?: unknown;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [indexState, setIndexState] = useState(() => ({
    firstItemIndex: MESSAGE_VIEWPORT_INDEX_BASE,
    firstKey: items[0]?.key,
  }));

  if (indexState.firstKey !== items[0]?.key) {
    setIndexState({
      firstItemIndex: reconcileFirstItemIndex(indexState.firstKey, indexState.firstItemIndex, items),
      firstKey: items[0]?.key,
    });
  }

  useEffect(() => {
    // Virtuoso remembers whether followOutput was active before the footer
    // grew. Calling this unconditionally avoids a race where the resize has
    // already emitted atBottom=false; it remains a no-op for readers who had
    // intentionally scrolled away.
    virtuosoRef.current?.autoscrollToBottom();
  }, [streamRevision]);

  useEffect(() => {
    if (!focusMessageId) return;
    const index = viewportItemIndexForMessage(items, focusMessageId);
    if (index < 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: indexState.firstItemIndex + index,
      align: "center",
      behavior: "smooth",
    });
  }, [focusMessageId, indexState.firstItemIndex, items]);

  const context: MessageViewportContext = {
    empty: items.length === 0,
    error: canLoadEarlier ? error : undefined,
    footer,
    loading: canLoadEarlier && loading,
    onRetry: () => void onLoadEarlier(),
  };

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso<T, MessageViewportContext>
        ref={virtuosoRef}
        className="h-full overflow-x-hidden px-5"
        role="log"
        aria-label={ariaLabel}
        aria-live="polite"
        alignToBottom
        atBottomThreshold={48}
        atBottomStateChange={setAtBottom}
        components={VIEWPORT_COMPONENTS}
        computeItemKey={(_index, item) => item.key}
        context={context}
        data={items}
        firstItemIndex={indexState.firstItemIndex}
        followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        increaseViewportBy={{ top: 320, bottom: 480 }}
        itemContent={(_index, item) => renderItem(item)}
        startReached={() => {
          if (canLoadEarlier && !loading && !error) void onLoadEarlier();
        }}
      />
      {!atBottom && (
        <button
          type="button"
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" })}
          aria-label="Jump to latest messages"
          className="animate-pop-in absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
    </div>
  );
}
