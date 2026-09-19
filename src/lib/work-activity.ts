import type { LiveActivitySegment, Message } from "@/state/store";
import type { CommandRunRow, MessageRow } from "./command-runs";

export type WorkActivitySegment = LiveActivitySegment | { kind: "persisted"; message: Message };

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Older transcripts lack runtime timing; estimate from the adjacent prompt
 * (when loaded) or first activity through the last message in this turn. */
export function workDuration(messages: Message[], transcript: Message[]): number {
  const saved = messages.find((message) => message.turnDurationMs !== undefined)?.turnDurationMs;
  if (saved !== undefined) return saved;
  const first = messages[0];
  const last = messages.at(-1);
  if (!first || !last) return 0;
  const previous = transcript[transcript.findIndex((message) => message.id === first.id) - 1];
  const startedAt = messages.find((message) => message.turnStartedAt !== undefined)?.turnStartedAt
    ?? (previous?.role === "user" ? previous.at : first.at);
  return Math.max(0, last.at - startedAt);
}

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
