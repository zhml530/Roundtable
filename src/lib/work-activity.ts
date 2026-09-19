import type { LiveActivitySegment, Message } from "@/state/store";
import type { CommandRunRow, MessageRow } from "./command-runs";

export type WorkActivitySegment = LiveActivitySegment | { kind: "persisted"; message: Message };

/** Transcript order is authoritative for persisted messages. Matching live
 * tool IDs anchor the event stream to it; timestamps only place unanchored
 * phases. Never deduplicate by title: repeated identical calls are common. */
export function mergeWorkActivity(
  rows: Array<CommandRunRow | MessageRow>,
  live: LiveActivitySegment[],
): WorkActivitySegment[] {
  const messages = rows.flatMap((row) => row.kind === "message" ? [row.message] : row.messages);
  const toolIndexes = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.tool?.itemId) toolIndexes.set(message.tool.itemId, index);
  });
  const result: WorkActivitySegment[] = [];
  let cursor = 0;
  for (let index = 0; index < live.length; index++) {
    const segment = live[index];
    const matched = segment.kind === "tool" ? toolIndexes.get(segment.itemId) : undefined;
    if (matched !== undefined) {
      while (cursor <= matched) result.push({ kind: "persisted", message: messages[cursor++] });
      continue;
    }
    // Do not cross the next matched tool: any reasoning before that tool
    // must stay before it even if timestamps share a millisecond.
    let boundary = messages.length;
    for (let next = index + 1; next < live.length; next++) {
      const candidate = live[next];
      const anchor = candidate.kind === "tool" ? toolIndexes.get(candidate.itemId) : undefined;
      if (anchor !== undefined) { boundary = anchor; break; }
    }
    while (cursor < boundary && messages[cursor].at <= segment.at) {
      result.push({ kind: "persisted", message: messages[cursor++] });
    }
    result.push(segment);
  }
  while (cursor < messages.length) result.push({ kind: "persisted", message: messages[cursor++] });
  return result;
}
