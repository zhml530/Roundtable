import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";

function DiagramCanvas({ svg, expand, expanded = false }: { svg: string; expand?: () => void; expanded?: boolean }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const resize = (value: number) => {
    const next = Math.min(5, Math.max(1, value));
    setZoom(next);
    if (next === 1) setPan({ x: 0, y: 0 });
  };
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [svg]);

  return (
    <div className={`group/diagram relative overflow-hidden bg-inset ${expanded ? "h-full" : "h-[min(60vh,480px)]"}`}>
      <div
        role="button" tabIndex={0} aria-label={expanded ? "Diagram canvas. Use plus and minus to zoom, arrow keys to pan." : "Expand Mermaid diagram"}
        className="absolute inset-0 touch-none select-none overflow-hidden"
        style={{ cursor: zoom > 1 ? dragging ? "grabbing" : "grab" : expand ? "zoom-in" : "default" }}
        onClick={() => { if (zoom === 1) expand?.(); }}
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") { event.preventDefault(); resize(zoom + 0.25); }
          else if (event.key === "-") { event.preventDefault(); resize(zoom - 0.25); }
          else if (event.key === "0") { event.preventDefault(); resize(1); }
          else if ((event.key === "Enter" || event.key === " ") && expand) { event.preventDefault(); expand(); }
          else if (zoom > 1 && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setPan((p) => ({ x: p.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: p.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }));
          }
        }}
        onPointerDown={(event) => {
          if (zoom <= 1 || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current) setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y });
        }}
        onPointerUp={() => { drag.current = null; setDragging(false); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      >
        <div
          className="pointer-events-none absolute inset-6 [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center" }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full border border-hairline/50 bg-card p-1 text-ink shadow-sm opacity-0 transition-opacity group-hover/diagram:opacity-100 group-focus-within/diagram:opacity-100 [@media(hover:none)]:opacity-100">
        <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1} onClick={() => resize(zoom - 0.25)} className="rounded-full p-2 hover:bg-raised disabled:opacity-30"><Minus size={17} /></button>
        <span className="min-w-10 text-center text-[12px] tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 5} onClick={() => resize(zoom + 0.25)} className="rounded-full p-2 hover:bg-raised disabled:opacity-30"><Plus size={17} /></button>
        <button type="button" aria-label="Fit diagram" title="Fit diagram" onClick={() => resize(1)} className="rounded-full p-2 hover:bg-raised"><RotateCcw size={16} /></button>
        {expand && <button type="button" aria-label="Open expanded diagram" title="Expand" onClick={expand} className="rounded-full p-2 hover:bg-raised"><Maximize2 size={16} /></button>}
      </div>
    </div>
  );
}

function ExpandedDiagram({ svg, close }: { svg: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return createPortal(
    <dialog ref={dialog} aria-label="Expanded Mermaid diagram" onCancel={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }} className="chat-area m-auto h-[90dvh] max-h-none w-[94vw] max-w-none overflow-hidden rounded-2xl border border-hairline bg-card p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="flex h-12 items-center justify-between border-b border-hairline/40 px-4">
        <span className="text-[13px]">Mermaid diagram</span>
        <button type="button" autoFocus aria-label="Close diagram" onClick={close} className="rounded-full p-2 hover:bg-raised"><X size={18} /></button>
      </div>
      <div className="h-[calc(100%-3rem)]"><DiagramCanvas svg={svg} expanded /></div>
    </dialog>, document.body,
  );
}

export function MermaidViewer({ svg }: { svg: string }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <DiagramCanvas svg={svg} expand={() => setExpanded(true)} />
    {expanded && <ExpandedDiagram svg={svg} close={() => setExpanded(false)} />}
  </>;
}
