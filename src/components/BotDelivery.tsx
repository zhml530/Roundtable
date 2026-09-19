import type { ChangedFile } from "@/lib/changed-files";

const labels = { created: "Added", modified: "Changed", deleted: "Removed" };

export function BotDelivery({ files }: { files: ChangedFile[] }) {
  if (files.length === 0) return null;
  return (
    <section className="mt-4 border-t border-hairline/40 pt-3" aria-label="Changed file">
      <div className="mb-1 text-[12px] font-semibold text-ink-secondary">Changed file</div>
      <ul className="space-y-1">
        {files.map((file) => (
          <li key={file.path} className="flex items-start gap-3 text-[13px]">
            <span className="w-16 shrink-0 text-[12px] text-ink-secondary">{labels[file.kind]}</span>
            <span className="min-w-0 break-all font-mono text-ink" title={file.path}>{file.path}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
