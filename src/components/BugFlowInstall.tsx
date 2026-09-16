import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { BugFlowInstallStatus } from "../../shared/bugflow-install";
import { api, useStore, type InstanceInfo } from "@/state/store";

export function BugFlowInstallCard({ status, busy, installed, onInstall }: {
  status: BugFlowInstallStatus;
  busy: boolean;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-3 text-[12px]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-ink">Standalone Windows EXE</span>
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {busy ? "Installing..." : installed ? "Rebuild & reinstall" : "Install fresh EXE"}
        </button>
      </div>
      <p className="mt-2 leading-relaxed text-ink-secondary">
        Fetches the latest published BugFlow source branch and builds a new EXE locally every time.
        Requires Git, Python 3.12 x64 with its launcher, existing source access and download access.
        Build tools are not bundled; the installed EXE needs no Python.
      </p>
      <p className="mt-1 leading-relaxed text-ink-secondary">
        No administrator access, login or host startup. Existing hosts keep running.
        ADO tools still require Azure CLI and your existing authorization.
      </p>
      {status.state !== "idle" && (
        <div className="mt-2" role={status.state === "failed" ? "alert" : "status"}>
          {status.state === "running" && (
            <progress aria-label="BugFlow installation progress" max={100} value={status.progress} className="mb-1 h-1.5 w-full accent-accent" />
          )}
          <p className={status.state === "failed" ? "text-danger" : "text-ink-secondary"}>{status.message}</p>
          {status.commit && <p className="mt-1 font-mono text-[11px] text-ink-secondary">Source: {status.commit.slice(0, 12)}</p>}
        </div>
      )}
    </div>
  );
}

export function BugFlowInstall({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<BugFlowInstallStatus>({ state: "idle", phase: "idle", message: "", progress: 0 });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshed = useRef<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result: { supported: boolean; installation: BugFlowInstallStatus } = await api("/api/bugflow/install");
        if (disposed) return;
        setSupported(result.supported);
        setStatus(result.installation);
        if (result.installation.state === "succeeded" && result.installation.attemptId !== refreshed.current) {
          refreshed.current = result.installation.attemptId;
          await refreshInstances();
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      } finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [refreshInstances]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const result: { installation: BugFlowInstallStatus } = await api("/api/bugflow/install", {
        method: "POST", body: JSON.stringify({ instanceId: instance.instanceId }),
      });
      setStatus(result.installation);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setStarting(false); }
  };
  if (!supported && !error) return null;
  return (
    <>
      {supported && <BugFlowInstallCard status={status} busy={starting || status.state === "running"} installed={Boolean(instance.cli)} onInstall={() => void start()} />}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </>
  );
}
