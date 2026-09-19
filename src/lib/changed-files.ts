import type { Message } from "@/state/store";
import type { CommandRunRow, MessageRow } from "./command-runs";
import type { ChangedFile } from "../../shared/changed-files";

export type { ChangedFile } from "../../shared/changed-files";

export function changedFileUrl(path: string, cwd?: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  if (/^[a-z]:\//i.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}/${normalized.slice(3).split("/").map(encodeURIComponent).join("/")}`;
  }
  if (normalized.startsWith("//")) return `file:${encoded}`;
  if (normalized.startsWith("/")) return `file://${encoded}`;
  const base = cwd ? changedFileUrl(cwd) : undefined;
  return base ? new URL(encoded, `${base.replace(/\/$/, "")}/`).href : undefined;
}

export function changedFilesFromMessages(messages: Message[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const message of messages) {
    if (message.kind !== "activity" || message.tool?.ok !== true) continue;
    for (const change of message.changedFiles ?? []) {
      const previous = byPath.get(change.path);
      const kind = previous?.kind === "created" && change.kind === "modified" ? "created" : change.kind;
      byPath.set(change.path, { ...change, kind });
    }
  }
  return [...byPath.values()];
}

export function changedFilesFromTurnRows(rows: Array<CommandRunRow | MessageRow>): ChangedFile[] {
  return changedFilesFromMessages(rows.flatMap((row) => row.kind === "command-run" ? row.messages : [row.message]));
}
