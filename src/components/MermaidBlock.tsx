import { useEffect, useState, type ReactNode } from "react";
import { MermaidViewer } from "./MermaidViewer";

// Mermaid's configuration is global: serialize initialization and rendering
// so simultaneous messages cannot change each other's theme mid-render.
let renderQueue: Promise<unknown> = Promise.resolve();

export function MermaidBlock({ code, streaming, source }: { code: string; streaming: boolean; source: ReactNode }) {
  const [skin, setSkin] = useState(() => typeof document === "undefined" ? "lagoon" : document.documentElement.dataset.skin);
  const [result, setResult] = useState<{ code: string; skin: string | undefined; svg: string }>();
  const [error, setError] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const observer = new MutationObserver(() => setSkin(document.documentElement.dataset.skin));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setCopied(false);
    const timer = setTimeout(() => {
      const work = renderQueue.then(async () => {
        if (cancelled) return;
        const { default: mermaid } = await import("mermaid");
        if (cancelled) return;
        const container = document.createElement("div");
        // Layout needs a connected element, but temporary SVGs must not flash.
        container.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;width:1000px";
        document.body.append(container);
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: skin === "lagoon" || skin === "atelier" ? "default" : "dark",
            fontFamily: "system-ui, sans-serif",
            maxTextSize: 50_000,
            maxEdges: 500,
          });
          const { svg } = await mermaid.render(`diagram-${crypto.randomUUID()}`, code, container);
          if (!cancelled) setResult({ code, skin, svg });
        } finally {
          container.remove();
        }
      });
      renderQueue = work.catch(() => { if (!cancelled) setError(true); });
    }, streaming ? 700 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, skin, streaming]);

  const svg = result?.code === code && result.skin === skin ? result.svg : undefined;
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-3 border-b border-hairline/30 px-3 py-2 text-[12px] text-ink-secondary">
        <span>Mermaid diagram</span>
        <div className="flex gap-3">
          {svg && <button type="button" className="hover:text-ink" onClick={() => setShowSource(!showSource)}>{showSource ? "Show diagram" : "Show source"}</button>}
          <button type="button" className="hover:text-ink" onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy source"}</button>
        </div>
      </div>
      {svg && !showSource ? (
        <MermaidViewer svg={svg} />
      ) : (
        <div className="px-3 pb-1">
          <p className="pt-2 text-[12px] text-ink-secondary" role="status">{error ? "Could not render this diagram. Source is shown below." : showSource ? "Diagram source" : streaming ? "Waiting for diagram content…" : "Rendering diagram…"}</p>
          {source}
        </div>
      )}
    </div>
  );
}
