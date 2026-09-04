import { existsSync, readdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ChannelArtifact { label: string; path: string; threadId: string }
const DOCUMENT = /\.(md|txt|csv|json|log|pdf|docx|xlsx|pptx|png|jpg|svg|py)$/i;
const SKIP = /^(?:\.|node_modules$|dist$|dist-server$|release$|__pycache__$)|(?:credential|secret|token|password|config|lock)/i;

export function withinWorkspace(root: string, file: string): string {
  const realRoot = realpathSync(root);
  const realFile = realpathSync(resolve(root, file));
  const rel = relative(realRoot, realFile);
  if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Artifact is outside the session workspace");
  return realFile;
}

/** Bounded discovery of produced/referenced documents, not arbitrary workspace files. */
export function collectChannelArtifacts(inputs: Array<{ threadId: string; cwd: string; output: string }>, since: number): ChannelArtifact[] {
  const artifacts: ChannelArtifact[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!existsSync(input.cwd)) continue;
    const queue = [{ dir: input.cwd, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 1500 && artifacts.length < 40) {
      const current = queue.shift()!;
      let entries;
      try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++visited > 1500 || artifacts.length >= 40) break;
        if (entry.isSymbolicLink() || SKIP.test(entry.name)) continue;
        const path = join(current.dir, entry.name);
        if (entry.isDirectory() && current.depth < 5) queue.push({ dir: path, depth: current.depth + 1 });
        if (!entry.isFile() || !DOCUMENT.test(entry.name) || seen.has(path)) continue;
        try {
          if (statSync(path).mtimeMs < since && !input.output.includes(entry.name)) continue;
          withinWorkspace(input.cwd, path);
          seen.add(path);
          artifacts.push({ label: relative(input.cwd, path), path, threadId: input.threadId });
        } catch { /* A removed or inaccessible file is not a usable artifact. */ }
      }
    }
  }
  return artifacts;
}

export function readChannelArtifact(root: string, path: string): { name: string; text?: string; base64?: string } {
  const file = withinWorkspace(root, path);
  if (!DOCUMENT.test(file)) throw new Error("Unsupported artifact format");
  if (statSync(file).size > 5 * 1024 * 1024) throw new Error("Artifact exceeds the 5 MB preview limit");
  const data = readFileSync(file);
  return /\.(pdf|docx|xlsx|pptx|png|jpg)$/i.test(extname(file))
    ? { name: basename(file), base64: data.toString("base64") }
    : { name: basename(file), text: data.toString("utf8") };
}
