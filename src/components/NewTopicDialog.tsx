import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useStore, type Group } from "@/state/store";
import { createChannelTopic } from "@/lib/channel-topics";

export function NewTopicDialog({ channel, onClose, onCreated }: {
  channel: Group;
  onClose: () => void;
  onCreated?: (topic: Group) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => dialog?.close();
  }, []);

  const create = async () => {
    if (!name.trim() || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const topic = await createChannelTopic(channel.channelId ?? channel.id, name, dispatch);
      onCreated?.(topic);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="new-topic-title" aria-describedby="new-topic-context"
      onCancel={(event) => { event.preventDefault(); if (!submitting.current) onClose(); }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-[360px] rounded-2xl border border-hairline/50 bg-card p-4 text-ink shadow-2xl shadow-black/60 backdrop:bg-black/45">
      <form onSubmit={(event) => { event.preventDefault(); void create(); }} aria-busy={saving}>
        <header className="mb-2 flex items-center gap-3">
          <h2 id="new-topic-title" className="min-w-0 flex-1 text-[15px] font-semibold">New Topic</h2>
          <button type="button" disabled={saving} onClick={onClose} aria-label="Close New Topic dialog"
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40">
            <X size={17} />
          </button>
        </header>
        <p id="new-topic-context" className="mb-4 break-words text-[12px] text-ink-secondary">
          In {channel.name}. Same agents and channel settings, separate conversation and context.
        </p>
        <label htmlFor="new-topic-name" className="mb-1.5 block text-[13px] font-medium">Topic name</label>
        <input ref={nameRef} id="new-topic-name" required maxLength={100} value={name} disabled={saving}
          onChange={(event) => setName(event.target.value)} placeholder="For example, Release planning"
          aria-describedby={error ? "new-topic-error" : undefined}
          className="w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50" />
        {error && <p id="new-topic-error" role="alert" className="mt-2 break-words text-[13px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onClose}
            className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={saving || !name.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40">
            {saving ? "Creating..." : "Create Topic"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
