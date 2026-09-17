// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("publishes a prepared CLI replacement without disposing sibling providers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    const configs = { a: { driver: "fake" }, b: { driver: "fake" } };
    await registry.load(configs);
    await registry.refresh();
    const sibling = registry.get("b")!;
    const disposeSibling = vi.spyOn(sibling, "dispose");
    const replacement = await fake.driver.create({
      instanceId: "a", displayName: "Replacement", enabled: true, environment: {}, config: {},
    });
    registry.replacePrepared(replacement, configs, "C:\\managed\\BugFlow.exe");
    expect(registry.get("a")).toBe(replacement);
    expect(registry.get("b")).toBe(sibling);
    expect(disposeSibling).not.toHaveBeenCalled();
    expect(registry.describeCached().find((entry) => entry.instanceId === "a")).toMatchObject({
      displayName: "Replacement", cli: "C:\\managed\\BugFlow.exe", refreshing: true,
    });
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("single-flights concurrent catalog refreshes", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const refreshModels = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    Object.assign(fake.created.get("a")!.instance, { refreshModels });

    const first = registry.refresh();
    const second = registry.refresh();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(refreshModels).toHaveBeenCalledTimes(1);
  });

  it("serves a matching persisted catalog without probing", async () => {
    const root = mkdtempSync(join(tmpdir(), "roundtable-provider-catalog-"));
    const catalogFile = join(root, "catalog.json");
    try {
      const firstFake = makeFakeDriver();
      const first = new ProviderRegistry([firstFake.driver], { catalogFile });
      await first.load({ a: { driver: "fake" } });
      await first.refresh();

      const secondFake = makeFakeDriver();
      const second = new ProviderRegistry([secondFake.driver], { catalogFile });
      await second.load({ a: { driver: "fake" } });
      const cached = second.describeCached();

      expect(cached[0]).toMatchObject({
        instanceId: "a",
        snapshot: { state: "available" },
        cached: true,
        refreshing: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates a persisted catalog when provider configuration changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "roundtable-provider-catalog-"));
    const catalogFile = join(root, "catalog.json");
    try {
      const first = new ProviderRegistry([makeFakeDriver().driver], { catalogFile });
      await first.load({ a: { driver: "fake" } });
      await first.refresh();

      const second = new ProviderRegistry([makeFakeDriver().driver], { catalogFile });
      await second.load({ b: { driver: "fake" } });

      expect(second.describeCached()[0]).toMatchObject({
        instanceId: "b",
        snapshot: { state: "unavailable", reason: "Checking provider availability…" },
        refreshing: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});
