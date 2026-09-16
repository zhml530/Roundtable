export const MESSAGE_VIEWPORT_INDEX_BASE = 1_000_000;

export interface KeyedViewportItem {
  key: string;
  messageIds: readonly string[];
}

/**
 * Keep Virtuoso's logical first index stable across appends and decrease it
 * exactly by the number of rows prepended. A replacement/branch switch that
 * does not contain the old first row starts a fresh index space.
 */
export function reconcileFirstItemIndex<T extends Pick<KeyedViewportItem, "key">>(
  previousFirstKey: string | undefined,
  previousFirstItemIndex: number,
  items: readonly T[],
): number {
  const nextFirstKey = items[0]?.key;
  if (previousFirstKey === nextFirstKey) return previousFirstItemIndex;
  const previousFirstOffset = previousFirstKey
    ? items.findIndex((item) => item.key === previousFirstKey)
    : -1;
  return previousFirstOffset > 0
    ? previousFirstItemIndex - previousFirstOffset
    : MESSAGE_VIEWPORT_INDEX_BASE;
}

export function viewportItemIndexForMessage<T extends Pick<KeyedViewportItem, "messageIds">>(
  items: readonly T[],
  messageId: string,
): number {
  return items.findIndex((item) => item.messageIds.includes(messageId));
}
