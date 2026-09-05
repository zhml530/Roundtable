import { useMemo, useRef, useState } from "react";
import { CheckCircle2, ImagePlus, Loader2, PlayCircle, Trash2 } from "lucide-react";

import {
  api,
  useStore,
  type CoordinatorSettings as CoordinatorSettingsValue,
  type ModelSelection,
} from "@/state/store";
import { cn } from "@/lib/cn";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { botAvatarUrlFromStoredPath, COORDINATOR_AVATAR_CROPS, type CoordinatorAvatarCrop } from "../../shared/bot-avatar";
import { CoordinatorAvatar } from "./Avatar";

const DEFAULTS: CoordinatorSettingsValue = {
  avatarUrl: null,
  avatarCrop: "circle",
  failureMode: "pause",
  preset: "balanced",
  planningTimeoutMs: 120_000,
  planningRetries: 1,
  maxConcurrency: 2,
  maxFixCycles: 2,
  maxRunMinutes: 60,
  requireHighRiskReview: true,
};

const PRESETS = {
  quality: { planningRetries: 2, maxConcurrency: 2, maxFixCycles: 3, planningTimeoutMs: 180_000 },
  balanced: { planningRetries: 1, maxConcurrency: 2, maxFixCycles: 2, planningTimeoutMs: 120_000 },
  economy: { planningRetries: 0, maxConcurrency: 2, maxFixCycles: 1, planningTimeoutMs: 60_000 },
} satisfies Record<CoordinatorSettingsValue["preset"], Partial<CoordinatorSettingsValue>>;

const CROP_LABEL = {
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<CoordinatorAvatarCrop, string>;

function CoordinatorAppearance({
  value,
  saving,
  onChange,
}: {
  value: CoordinatorSettingsValue;
  saving: boolean;
  onChange: (patch: Pick<CoordinatorSettingsValue, "avatarUrl" | "avatarCrop">) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      onChange({ avatarUrl, avatarCrop: value.avatarCrop });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Appearance</div>
      <div className="mt-1 text-[12.5px] text-ink-secondary">Shown with Coordinator answers in every Channel. Coordinator remains a system service, not an Agent.</div>
      <div className="mt-4 flex items-center gap-4">
        <CoordinatorAvatar avatarUrl={value.avatarUrl} avatarCrop={value.avatarCrop} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="text-[14px] font-medium text-ink">Coordinator</span><span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">System</span></div>
          <div className="mt-3 flex gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={(event) => void upload(event.target.files?.[0])} />
            <button type="button" disabled={saving || uploading} onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />} Upload image
            </button>
            {value.avatarUrl && <button type="button" aria-label="Restore default Coordinator avatar" title="Restore default" disabled={saving || uploading} onClick={() => onChange({ avatarUrl: null, avatarCrop: "circle" })} className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={14} /></button>}
          </div>
        </div>
      </div>
      {value.avatarUrl && <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-lg border border-hairline/40">{COORDINATOR_AVATAR_CROPS.map((crop, index) => <button key={crop} type="button" aria-pressed={value.avatarCrop === crop} onClick={() => onChange({ avatarUrl: value.avatarUrl, avatarCrop: crop })} className={cn("py-1.5 text-[12.5px]", index > 0 && "border-l border-hairline/40", value.avatarCrop === crop ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink")}>{CROP_LABEL[crop]}</button>)}</div>}
      {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function SelectionFields({
  label,
  value,
  optional,
  onChange,
}: {
  label: string;
  value?: ModelSelection;
  optional?: boolean;
  onChange: (value: ModelSelection | undefined) => void;
}) {
  const { state } = useStore();
  const instances = state.instances;
  const available = instances.filter((instance) => instance.snapshot.state === "available");
  const instance = available.find((candidate) => candidate.instanceId === value?.instanceId) ?? available[0];
  const selected = value ?? (instance ? { instanceId: instance.instanceId, model: instance.models.default } : undefined);
  const effortLevels = instance?.capabilities?.effortLevels ?? [];

  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-ink">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={`${label} engine`}
          value={value?.instanceId ?? (optional ? "" : selected?.instanceId ?? "")}
          onChange={(event) => {
            if (!event.target.value) return onChange(undefined);
            const next = available.find((candidate) => candidate.instanceId === event.target.value);
            if (next) onChange({ instanceId: next.instanceId, model: next.models.default });
          }}
          className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink"
        >
          {optional && <option value="">None</option>}
          {!available.length && <option value="">No ready engines</option>}
          {instances.map((candidate) => <option key={candidate.instanceId} value={candidate.instanceId} disabled={candidate.snapshot.state !== "available"}>{candidate.displayName} · {candidate.snapshot.state === "available" ? (candidate.snapshot.authenticated === false ? "Sign-in required" : "Ready") : "Unavailable"}</option>)}
        </select>
        <select
          aria-label={`${label} model`}
          disabled={!selected}
          value={selected?.model ?? ""}
          onChange={(event) => selected && onChange({ ...selected, model: event.target.value })}
          className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink disabled:opacity-50"
        >
          {instance?.models.options.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </div>
      {!!effortLevels.length && selected && (
        <select
          aria-label={`${label} reasoning effort`}
          value={selected.effort ?? ""}
          onChange={(event) => onChange({ ...selected, effort: effortLevels.find((effort) => effort === event.target.value) })}
          className="mt-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] capitalize text-ink"
        >
          <option value="">Default effort</option>
          {effortLevels.map((effort) => <option key={effort} value={effort}>{effort === "xhigh" ? "X-High" : effort}</option>)}
        </select>
      )}
    </div>
  );
}

export function CoordinatorSettings() {
  const { state, dispatch } = useStore();
  const initial = useMemo(() => ({ ...DEFAULTS, ...state.config?.coordinator }), [state.config?.coordinator]);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "error"; message?: string }>({ state: "idle" });

  const save = async (next: CoordinatorSettingsValue) => {
    setDraft(next);
    setSaving(true);
    setSaveError("");
    try {
      const config = await api("/api/config", { method: "PATCH", body: JSON.stringify({ coordinator: next }) });
      dispatch({ type: "configStatus", config });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const testCoordinator = async () => {
    setTest({ state: "running" });
    try {
      const result = await api("/api/coordinator/test", { method: "POST", body: "{}" });
      setTest({ state: "ok", message: `${result.model.instanceId} / ${result.model.model} · ${result.latencyMs} ms` });
    } catch (error) {
      setTest({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CoordinatorAppearance value={draft} saving={saving} onChange={(appearance) => void save({ ...draft, ...appearance })} />
      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Model policy</div>
        <div className="mt-1 text-[12.5px] text-ink-secondary">Dedicated, tool-free models used only for planning and coordination decisions.</div>
        <div className="mt-4 flex flex-col gap-4">
          <SelectionFields label="Primary" value={draft.primary} onChange={(primary) => primary && void save({ ...draft, primary })} />
          <SelectionFields label="Backup" optional value={draft.backup} onChange={(backup) => void save({ ...draft, backup })} />
          <label className="text-[13px] text-ink">When Primary fails
            <select value={draft.failureMode} onChange={(event) => void save({ ...draft, failureMode: event.target.value === "fallback" ? "fallback" : "pause" })} className="ml-3 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-ink">
              <option value="pause">Pause the run</option><option value="fallback" disabled={!draft.backup}>Use Backup</option>
            </select>
          </label>
          <button disabled={!state.instances.some((instance) => instance.snapshot.state === "available") || saving || test.state === "running"} onClick={() => void testCoordinator()} className="flex w-fit items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {test.state === "running" ? <Loader2 size={14} className="animate-spin" /> : test.state === "ok" ? <CheckCircle2 size={14} className="text-emerald-500" /> : <PlayCircle size={14} />}
            Test Coordinator
          </button>
          {test.message && <div className={cn("text-[12px]", test.state === "error" ? "text-danger" : "text-ink-secondary")}>{test.message}</div>}
          {saveError && <div className="text-[12px] text-danger">{saveError}</div>}
        </div>
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Runtime policy</div>
        <p className="mt-2 text-[13px] text-ink-secondary">Up to 2 tasks run at once per channel. Coordinator decides which tasks are independent; @everyone includes every Bot in the plan.</p>
        <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
          {(["quality", "balanced", "economy"] as const).map((preset) => <button key={preset} onClick={() => void save({ ...draft, ...PRESETS[preset], preset })} className={cn("flex-1 py-2 text-[13px] capitalize", draft.preset === preset ? "bg-control text-ink" : "text-ink-secondary")}>{preset}</button>)}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
          {([
            ["Planning timeout (seconds)", "planningTimeoutMs", draft.planningTimeoutMs / 1000, 10, 600, 1000],
            ["Planning retries", "planningRetries", draft.planningRetries, 0, 3, 1],
            ["Maximum review replans", "maxFixCycles", draft.maxFixCycles, 0, 10, 1],
            ["Run time budget (minutes)", "maxRunMinutes", draft.maxRunMinutes, 1, 1440, 1],
          ] as const).map(([label, key, value, min, max, multiplier]) => (
            <label key={key} className="text-ink-secondary">{label}
              <input type="number" min={min} max={max} value={value} onChange={(event) => void save({ ...draft, [key]: Number(event.target.value) * multiplier })} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-ink" />
            </label>
          ))}
        </div>
        <label className="mt-4 flex items-center justify-between gap-4 text-[13px] text-ink">
          Require Reviewer for high-risk goals
          <input type="checkbox" checked={draft.requireHighRiskReview} onChange={(event) => void save({ ...draft, requireHighRiskReview: event.target.checked })} />
        </label>
      </div>

      <div className="rounded-xl bg-card p-4 text-[12.5px] text-ink-secondary">
        <div className="font-medium text-ink">Diagnostics</div>
        <div className="mt-2">Prompt: coordinator-planner-v2 · Model policy: v1 · Runtime policy: v2</div>
        <div className="mt-1">Active runs keep an immutable copy of these settings.</div>
      </div>
    </div>
  );
}
