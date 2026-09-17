// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import { findCliCandidates } from "../env-path.ts";
import type {
  AnyProviderDriver,
  EffortLevel,
  EngineInstall,
  InstanceConfigMap,
  InstanceId,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

export interface ProviderDescription {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities: {
    computerMcp: boolean;
    agentsMcp: boolean;
    composioMcp?: boolean;
    images?: boolean;
    files?: boolean;
    customModels?: boolean;
    explicitApprovals?: boolean;
    effortLevels?: readonly EffortLevel[];
    queueing?: boolean;
  };
  access: "subscription" | "custom";
  install?: EngineInstall;
  cli?: string;
  cliDefault?: string;
  cliCandidates: string[];
  cached?: boolean;
  refreshing?: boolean;
}

interface CatalogFile {
  version: 1;
  configHash: string;
  descriptions: ProviderDescription[];
}

function configHash(configs: InstanceConfigMap): string {
  return createHash("sha256").update(JSON.stringify(configs)).digest("hex");
}

function readCatalog(path: string | undefined, expectedHash: string): ProviderDescription[] | null {
  if (!path) return null;
  try {
    const parsed: Partial<CatalogFile> = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.version !== 1 || parsed.configHash !== expectedHash || !Array.isArray(parsed.descriptions)) return null;
    return parsed.descriptions;
  } catch {
    return null;
  }
}

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private driversByKind: Map<string, AnyProviderDriver>;
  private readonly catalogFile: string | undefined;
  private currentConfigHash = "";
  private catalog: ProviderDescription[] | null = null;
  private refreshInFlight: Promise<ProviderDescription[]> | null = null;
  private generation = 0;

  constructor(drivers: readonly AnyProviderDriver[], options: { catalogFile?: string } = {}) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    this.catalogFile = options.catalogFile;
  }

  async load(configs: InstanceConfigMap) {
    this.generation += 1;
    this.currentConfigHash = configHash(configs);
    this.catalog = readCatalog(this.catalogFile, this.currentConfigHash);
    for (const [instanceId, entry] of Object.entries(configs)) {
      const driver = this.driversByKind.get(entry.driver);
      if (!driver) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName,
            cli: cliOfRaw(entry.config),
            shadow: true,
            reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
          },
        });
        continue;
      }
      try {
        const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
        // Override detection is on the RAW config, never the decoded one:
        // decodeConfig fills in the driver default ("claude", "codex", …),
        // so reading `cli` there would flag every instance as overridden.
        const rawCli = cliOfRaw(entry.config);
        if (rawCli) this.cliByInstance.set(instanceId, rawCli);
        const live = await driver.create({
          instanceId,
          displayName: entry.displayName ?? driver.metadata.displayName,
          environment: entry.environment ?? {},
          enabled: entry.enabled ?? true,
          config,
        });
        this.byId.set(instanceId, { instanceId, live });
      } catch (e) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName ?? driver.metadata.displayName,
            cli: cliOfRaw(entry.config),
            shadow: true,
            reason: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** Publish a prepared replacement without disposing unrelated providers. */
  replacePrepared(instance: ProviderInstance, configs: InstanceConfigMap, cli: string): void {
    this.byId.set(instance.instanceId, { instanceId: instance.instanceId, live: instance });
    this.cliByInstance.set(instance.instanceId, cli);
    this.generation += 1;
    this.currentConfigHash = configHash(configs);
    this.catalog = null;
    this.refreshInFlight = null;
  }

  /** Immediate startup shape. Cached health is explicitly stale; a first
   * install receives checking rows rather than a fabricated available state. */
  describeCached(): ProviderDescription[] {
    if (this.catalog) {
      return this.catalog.map((description) => ({
        ...description,
        cached: true,
        refreshing: true,
      }));
    }
    return this.entries().map((entry) => {
      const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
      const instance = entry.live;
      return {
        instanceId: entry.instanceId,
        driverKind: entry.shadow?.driverKind ?? instance!.driverKind,
        displayName:
          entry.shadow?.displayName ??
          instance?.displayName ??
          entry.shadow?.driverKind ??
          instance!.driverKind,
        snapshot: {
          state: "unavailable",
          reason: entry.shadow?.reason ?? "Checking provider availability…",
        },
        models: entry.shadow ? { default: "", options: [] } : instance!.models,
        capabilities: {
          computerMcp: instance?.adapter.capabilities.computerMcp === true,
          agentsMcp: instance?.adapter.capabilities.agentsMcp === true,
          composioMcp: instance?.adapter.capabilities.composioMcp === true,
          images: instance?.adapter.capabilities.images === true,
          files: instance?.adapter.capabilities.files,
          customModels: instance?.adapter.capabilities.customModels,
          explicitApprovals: instance?.adapter.capabilities.explicitApprovals,
          effortLevels: instance?.adapter.capabilities.effortLevels,
          queueing: instance?.adapter.capabilities.queueing === true,
        },
        access: driver?.metadata.access ?? "subscription",
        install: driver?.install,
        cli: entry.shadow?.cli ?? (instance ? this.cliByInstance.get(instance.instanceId) : undefined),
        cliDefault: cliDefaultOf(driver),
        cliCandidates: [],
        refreshing: true,
      };
    });
  }

  /** Backward-compatible live description for callers that require a probe. */
  async describe(): Promise<ProviderDescription[]> {
    return this.refresh();
  }

  /** Startup, picker reads and manual checks share one provider probe. */
  refresh(): Promise<ProviderDescription[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const generation = this.generation;
    const request = this.probe(generation);
    const tracked = request.finally(() => {
      if (this.refreshInFlight === tracked) this.refreshInFlight = null;
    });
    this.refreshInFlight = tracked;
    return this.refreshInFlight;
  }

  private async probe(generation: number): Promise<ProviderDescription[]> {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    const candidatesFor = (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    const descriptions = await Promise.all(
      this.entries().map(async (entry) => {
        const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { computerMcp: false, agentsMcp: false },
            // an unknown driver has no driver record, hence no install path
            access: driver?.metadata.access ?? "subscription",
            install: driver?.install,
            cli: entry.shadow.cli,
            cliDefault: cliDefaultOf(driver),
            // a shadow is exactly the "your CLI is broken, pick another"
            // case where the detected-path dropdown matters most
            cliCandidates: candidatesFor(driver),
          } satisfies ProviderDescription;
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          await inst.refreshModels?.();
          snapshot = await inst.snapshot();
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        const cached = this.catalog?.find((description) => description.instanceId === inst.instanceId);
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models:
            snapshot.state === "unavailable" && cached?.models.options.length
              ? cached.models
              : inst.models,
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            images: inst.adapter.capabilities.images === true,
            files: inst.adapter.capabilities.files,
            customModels: inst.adapter.capabilities.customModels,
            explicitApprovals: inst.adapter.capabilities.explicitApprovals,
            effortLevels: inst.adapter.capabilities.effortLevels,
            queueing: inst.adapter.capabilities.queueing === true,
          },
          access: driver?.metadata.access ?? "subscription",
          install: driver?.install,
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          // every copy of the driver's default binary on the augmented PATH —
          // the dropdown's "detected" entries. Snapshotted per describe() so a
          // newly installed CLI shows up on the next refresh.
          cliCandidates: candidatesFor(driver),
        } satisfies ProviderDescription;
      }),
    );
    if (generation !== this.generation) return this.describeCached();
    this.catalog = descriptions;
    if (this.catalogFile) {
      try {
        writeFileAtomic(
          this.catalogFile,
          `${JSON.stringify({
            version: 1,
            configHash: this.currentConfigHash,
            descriptions,
          } satisfies CatalogFile, null, 2)}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        console.warn("Could not persist provider catalog:", error);
      }
    }
    return descriptions;
  }

  async disposeAll() {
    this.generation += 1;
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.refreshInFlight = null;
  }
}
