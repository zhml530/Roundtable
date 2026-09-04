import { useState } from "react";
import { api, type Message } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";

/** Answer is rendered by the caller; artifacts and audit details follow it. */
export function ChannelDelivery({ groupId, message }: { groupId: string; message: Message }) {
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const open = async (artifact: NonNullable<Message["artifacts"]>[number]) => {
    setError(null);
    setLoading(artifact.path);
    try {
      const result = await api(`/api/groups/${groupId}/artifacts?${new URLSearchParams({ path: artifact.path, threadId: artifact.threadId })}`);
      if (typeof result.text === "string") setPreview({ name: result.name, text: result.text });
      else if (typeof result.base64 === "string") {
        const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = result.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(null); }
  };
  return <>
    {!!message.artifacts?.length && <section className="mt-4 border-t border-hairline/40 pt-3" aria-label="Supporting files">
      <div className="mb-1 text-[12px] font-semibold text-ink-secondary">Supporting files</div>
      {message.artifacts.map((artifact) => <button key={`${artifact.threadId}:${artifact.path}`} title={artifact.path} disabled={loading !== null}
        onClick={() => void open(artifact)} className="block break-all text-left text-[13px] text-accent underline">
        {loading === artifact.path ? "Opening… " : ""}{artifact.label}
      </button>)}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {preview && <div className="mt-2 rounded-lg border border-hairline/40 p-3">
        <div className="flex justify-between gap-3 text-[12px]"><strong>{preview.name}</strong><button onClick={() => setPreview(null)}>Close preview</button></div>
        <div className="max-h-96 overflow-auto">{preview.name.endsWith(".md") ? <ChatMarkdown text={preview.text} /> : <pre className="whitespace-pre-wrap text-[12px]">{preview.text}</pre>}</div>
      </div>}
    </section>}
    {message.executionReport && <details className="mt-4 border-t border-hairline/40 pt-2 text-[12px]">
      <summary className="cursor-pointer text-ink-secondary">Execution details</summary>
      <div className="mt-2 max-h-96 overflow-auto"><ChatMarkdown text={message.executionReport} /></div>
    </details>}
  </>;
}
