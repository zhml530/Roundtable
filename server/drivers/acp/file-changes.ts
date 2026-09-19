import { z } from "zod";
import type { ChangedFile } from "../../../shared/changed-files.ts";

const metadata = z.object({
  toolCallId: z.string(),
  title: z.string().nullish(),
  kind: z.string().nullish(),
  status: z.string().nullish(),
  locations: z.array(z.object({ path: z.string() })).nullish(),
  content: z.array(z.unknown()).nullish(),
  rawInput: z.unknown().optional(),
});
type AcpFileMetadata = z.input<typeof metadata>;
const diff = z.object({
  type: z.literal("diff"),
  path: z.string(),
  oldText: z.string().nullish(),
  newText: z.string().nullish(),
});
const fileInput = z.object({
  path: z.string().optional(),
  file_path: z.string().optional(),
  filePath: z.string().optional(),
});

/** ACP updates are partial; retain metadata until the tool succeeds. Read
 * locations and proposed/failed edits must never become changed files. */
export function createAcpFileChanges() {
  const tools = new Map<string, {
    kind?: string;
    status?: string;
    paths: Set<string>;
    diffs: Map<string, ChangedFile>;
  }>();
  return (update: AcpFileMetadata): ChangedFile[] | undefined => {
    const parsed = metadata.safeParse(update);
    if (!parsed.success) {
      console.warn("ACP: invalid file-change metadata", parsed.error.message);
      return undefined;
    }
    const value = parsed.data;
    let tool = tools.get(value.toolCallId);
    if (!tool) {
      tool = { paths: new Set(), diffs: new Map() };
      tools.set(value.toolCallId, tool);
    }
    if (value.kind) tool.kind = value.kind;
    if (value.status) tool.status = value.status;
    for (const location of value.locations ?? []) {
      if (location.path.trim()) tool.paths.add(location.path);
    }
    const input = fileInput.safeParse(value.rawInput);
    if (input.success) {
      const path = input.data.path ?? input.data.file_path ?? input.data.filePath;
      if (path?.trim()) tool.paths.add(path);
    }
    for (const content of value.content ?? []) {
      const parsedDiff = diff.safeParse(content);
      if (!parsedDiff.success || !parsedDiff.data.path.trim()) continue;
      const { path, oldText, newText } = parsedDiff.data;
      if (oldText === undefined && newText === undefined) continue;
      tool.diffs.set(path, {
        path,
        kind: newText === null ? "deleted" : oldText === null ? "created" : "modified",
      });
    }
    if (tool.status !== "completed") return undefined;
    const changes = new Map(tool.diffs);
    if (tool.kind === "edit" || tool.kind === "delete") {
      for (const path of tool.paths) {
        if (tool.kind === "delete" || !changes.has(path)) {
          changes.set(path, { path, kind: tool.kind === "delete" ? "deleted" : "modified" });
        }
      }
    }
    return [...changes.values()];
  };
}
