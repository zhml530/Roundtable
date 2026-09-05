// Roundtable-owned durable project state for long-running Channels.
//
// This is deliberately separate from each Bot's private MEMORY.md and from the
// user's project checkout. A Channel may replace Bots or provider sessions, but
// its Coordinator still needs one compact, recoverable view of the project.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const CHANNEL_PROJECTS_DIR = join(DATA_DIR, "channel-projects");
export const PROJECT_STATE_MAX_BYTES = 32 * 1024;

const CHANNEL_ID = /^[\w-]{1,200}$/;

function requireChannelId(groupId: string): string {
  if (!CHANNEL_ID.test(groupId)) throw new Error("invalid Channel id");
  return groupId;
}

export function channelProjectStatePath(groupId: string): string {
  return join(CHANNEL_PROJECTS_DIR, requireChannelId(groupId), "PROJECT_STATE.md");
}

function boundedUtf8(text: string, maxBytes = PROJECT_STATE_MAX_BYTES): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  return Buffer.from(normalized, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "").trimEnd();
}

export function loadChannelProjectState(groupId: string): string | null {
  try {
    const text = boundedUtf8(readFileSync(channelProjectStatePath(groupId), "utf8"));
    return text || null;
  } catch {
    return null;
  }
}

export function writeChannelProjectState(groupId: string, text: string): { path: string; bytes: number } {
  const path = channelProjectStatePath(groupId);
  const bounded = boundedUtf8(text);
  if (!bounded) throw new Error("Coordinator returned an empty project state");
  mkdirSync(join(CHANNEL_PROJECTS_DIR, requireChannelId(groupId)), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${bounded}\n`, { mode: 0o600 });
  return { path, bytes: Buffer.byteLength(bounded, "utf8") };
}
