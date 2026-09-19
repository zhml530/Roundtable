import { changedFileUrl, type ChangedFile } from "@/lib/changed-files";

const labels = { created: "Added", modified: "Changed", deleted: "Removed" };

export function BotDelivery({ files, cwd }: { files: ChangedFile[]; cwd?: string }) {
  if (files.length === 0) return null;
  return (
    <section aria-label="Changed file">
      <div className="mb-1 text-[12px] font-semibold text-ink-secondary">Changed file</div>
      <ul className="space-y-1">
        {files.map((file) => {
          const name = file.path.split(/[\\/]/).at(-1);
          const href = changedFileUrl(file.path, cwd);
          return (
          <li key={file.path} className="flex items-start gap-3 text-[13px]">
            <span className="w-16 shrink-0 text-[12px] text-ink-secondary">{labels[file.kind]}</span>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" title={file.path}
                className="min-w-0 break-all font-mono text-accent underline decoration-accent/40 hover:decoration-accent">
                {name}
              </a>
            ) : (
              <span className="min-w-0 break-all font-mono text-ink" title={`${file.path} (working directory unavailable)`}>{name}</span>
            )}
          </li>
          );
        })}
      </ul>
    </section>
  );
}
