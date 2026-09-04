import { useState } from "react";
import { api, type Message } from "@/state/store";

export function ChannelQuestion({ threadId, message }: { threadId: string; message: Message }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = message.card!;
  const submit = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true); setError(null);
    try { await api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, sourceThreadId: message.source?.threadId, behavior: "answer", message: text }) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="max-w-[840px] rounded-xl border border-accent/30 bg-card p-3">
    <strong>{card.title}</strong><p className="whitespace-pre-wrap">{card.subtitle}</p>
    {card.answered || card.dismissed ? <p className="text-ink-secondary">{card.dismissed ? "No longer waiting" : "Answered"}</p> : <>
      <div className="my-2 flex flex-wrap gap-2">{card.options.map((option) => <button key={option} disabled={busy} onClick={() => void submit(option)} className="rounded border border-hairline/50 px-2 py-1">{option}</button>)}</div>
      <form onSubmit={(event) => { event.preventDefault(); void submit(answer); }} className="flex gap-2">
        <input aria-label={`Answer ${message.from?.name ?? "Bot"}`} value={answer} onChange={(event) => setAnswer(event.target.value)} className="min-w-0 flex-1 rounded bg-inset px-2 py-1" />
        <button disabled={busy || !answer.trim()} type="submit">Send answer</button>
      </form>
    </>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
