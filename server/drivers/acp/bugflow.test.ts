import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs, instanceConfigs } from "../../config.ts";
import { autoVerdict } from "../../auto-approve.ts";
import { execCli, spawnCli } from "../../procs.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { BUGFLOW_MODEL, BugFlowAgentDriver, createBugFlowAgentDriver, probeBugFlow } from "./bugflow.ts";

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const ready: typeof execCli = (_cli, _args, _opts, cb) =>
  cb(null, JSON.stringify({ state: "ready", message: "Host ready", version: "0.1.0" }));

describe("BugFlow readiness", () => {
  it.each([
    ["ready", "available", true],
    ["auth_required", "available", false],
    ["unavailable", "unavailable", false],
  ] as const)("maps %s without losing the host's message", async (state, mapped, authenticated) => {
    const calls: unknown[] = [];
    const run: typeof execCli = (cli, args, opts, cb) => {
      calls.push({ cli, args, env: opts.env, timeout: opts.timeout });
      cb(null, JSON.stringify({ state, message: "Required next action", version: "0.1.0" }));
    };
    expect(await probeBugFlow("C:\\Agent Path\\bugflow-agent.exe", { TEST: "value" }, run)).toEqual({
      state: mapped, authenticated, reason: "Required next action", version: "0.1.0",
    });
    expect(calls).toEqual([{
      cli: "C:\\Agent Path\\bugflow-agent.exe", args: ["status", "--json"], env: { TEST: "value" }, timeout: 5000,
    }]);
  });

  it.each([
    "not json", '{"state":"ready"}', '{"state":"unknown","message":"bad","version":"1"}',
    '{"state":"ready","message":"","version":"1"}',
    '{"state":"ready","message":"ok","version":"1"}\n{}',
  ])("fails closed for malformed status %s", async (stdout) => {
    const run: typeof execCli = (_cli, _args, _opts, cb) => cb(null, stdout);
    expect(await probeBugFlow("test", {}, run)).toMatchObject({ state: "unavailable", authenticated: false });
  });

  it("does not trust a ready-shaped output after nonzero exit", async () => {
    const run: typeof execCli = (_cli, _args, _opts, cb) =>
      cb(new Error("status failed"), '{"state":"ready","message":"ok","version":"1"}');
    expect(await probeBugFlow("test", {}, run)).toMatchObject({
      state: "unavailable", authenticated: false, reason: expect.stringContaining("status failed"),
    });
  });
});

describe("BugFlow ACP integration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function harness(mode = "happy", run: typeof execCli = ready) {
    ensureDirs();
    const dir = mkdtempSync(join(tmpdir(), "roundtable-bugflow-test-"));
    const dump = join(dir, "dump.json");
    const calls: Array<{ cli: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const closed: Promise<void>[] = [];
    const children: ReturnType<typeof spawnCli>[] = [];
    const spawn: typeof spawnCli = (cli, args, opts) => {
      calls.push({ cli, args, env: opts.env });
      const child = spawnCli(process.execPath, [FAKE_CLI], {
        ...opts,
        env: { ...opts.env, FAKE_ACP_MODE: mode, FAKE_ACP_DUMP: dump, FAKE_ACP_RPC_DUMP: `${dump}.rpc` },
      });
      children.push(child);
      closed.push(new Promise((resolve) => child.once("close", () => resolve())));
      return child;
    };
    const driver = createBugFlowAgentDriver(run, spawn);
    const instance = await driver.create({
      instanceId: "bugflow", displayName: "BugFlow Agent", enabled: true,
      config: driver.decodeConfig({ cli: "C:\\Agent Path\\bugflow-agent.exe", fullAuto: true }),
      environment: {
        COPILOT_GITHUB_TOKEN: "secret", GH_TOKEN: "secret", GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", BOX_TOKEN: "secret",
        COPILOT_PROVIDER_BASE_URL: "https://not-allowed.invalid", COPILOT_MODEL: "not-allowed",
        OPENROUTER_API_KEY: "secret", KIMI_MODEL_BASE_URL: "http://localhost:1234",
      },
    });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(async () => {
      recorder.stop();
      await instance.dispose();
      await Promise.all(closed);
      await removeTempDir(dir);
    });
    const methods = () => JSON.parse(readFileSync(`${dump}.rpc`, "utf8")) as string[];
    return { instance, recorder, dump, calls, methods, children, closed };
  }

  it("registers a separate provider and default instance without inheriting Copilot configuration", () => {
    expect(BugFlowAgentDriver.driverKind).toBe("bugflowAgent");
    expect(BugFlowAgentDriver.defaultConfig()).toMatchObject({ cli: "bugflow-agent", fullAuto: false });
    expect(BugFlowAgentDriver.models.options).toEqual([{ id: BUGFLOW_MODEL, label: "BugFlow (agent-controlled)" }]);
    expect(instanceConfigs({}).bugflow).toEqual({ driver: "bugflowAgent", environment: {} });
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).bugflow?.driver).toBe("bugflowAgent");
  });

  it("counts readiness preflight as active and cannot spawn after disposal", async () => {
    let release = () => {};
    const probe: typeof execCli = (_cli, _args, _opts, cb) => {
      release = () => cb(null, JSON.stringify({ state: "ready", message: "Host ready", version: "0.1.0" }));
    };
    const { instance, calls } = await harness("happy", probe);
    const pending = instance.adapter.sendTurn({ threadId: "pending", text: "hello", model: BUGFLOW_MODEL });
    expect(instance.adapter.hasActiveTurns?.()).toBe(true);
    expect(instance.adapter.hasSession("pending")).toBe(false);
    await instance.dispose();
    release();
    await expect(pending).rejects.toThrow("disposed during readiness");
    expect(instance.adapter.hasActiveTurns?.()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("streams through a disposable acp bridge without model RPCs, vendor keys or local integrations", async () => {
    const { instance, recorder, dump, calls, methods, children, closed } = await harness();
    expect(instance.adapter.capabilities).toMatchObject({
      files: false, images: false, customModels: false, explicitApprovals: true,
      agentsMcp: false, computerMcp: false, composioMcp: false,
    });
    await instance.adapter.sendTurn({
      threadId: "thread", text: "hello", model: BUGFLOW_MODEL,
      integrations: { agents: { command: "never-start.exe", args: [], env: { SECRET: "secret" } } },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "content.delta", delta: "hello from fake acp" }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool" }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "session.started", model: BUGFLOW_MODEL }));
    expect(calls[0]).toMatchObject({ cli: "C:\\Agent Path\\bugflow-agent.exe", args: ["acp"] });
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "BOX_TOKEN", "COPILOT_PROVIDER_BASE_URL", "COPILOT_MODEL", "OPENROUTER_API_KEY", "KIMI_MODEL_BASE_URL"]) {
      expect(calls[0].env?.[key]).toBeUndefined();
    }
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toEqual([]);
    expect(methods()).toEqual(["initialize", "session/new", "session/prompt", "session/prompt.result"]);
    await Promise.all(closed);
    expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
    expect(instance.adapter.hasSession("thread")).toBe(false);
  });

  it.each(["/analyze 4702949", "Explain the current report"])("preserves raw user input %s without a Roundtable persona", async (text) => {
    const { instance, recorder, dump } = await harness();
    await instance.adapter.sendTurn({
      threadId: "thread", text, system: "You are a generic Roundtable assistant.", model: BUGFLOW_MODEL,
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8"))).toEqual([{ type: "text", text }]);
  });

  it.each(["load-fails", "load-unsupported", "load-mismatch"])("strict resume rejects %s without session/new", async (mode) => {
    const { instance, recorder, methods } = await harness(mode);
    await instance.adapter.sendTurn({ threadId: "thread", text: "continue", resumeCursor: "saved-session" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error", message: expect.stringContaining("no new session was created"),
    }));
    expect(methods()).not.toContain("session/new");
    expect(methods()).not.toContain("session/prompt");
    if (mode === "load-unsupported") expect(methods()).not.toContain("session/load");
  });

  it("resumes the exact session, suppressing historical text and tool replay", async () => {
    const { instance, recorder, dump, methods } = await harness("load-replay");
    await instance.adapter.sendTurn({ threadId: "another-thread", text: "continue", resumeCursor: "saved-session" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.load.json`, "utf8"))).toMatchObject({ sessionId: "saved-session", mcpServers: [] });
    expect(methods()).not.toContain("session/new");
    expect(JSON.stringify(recorder.events)).not.toContain("historical");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "session.started", sessionId: "saved-session" }));
  });

  it.each(["", 123, { sessionId: "saved" }])("rejects invalid saved cursor %j before spawning", async (resumeCursor) => {
    const { instance, recorder, calls } = await harness();
    await instance.adapter.sendTurn({ threadId: "thread", text: "continue", resumeCursor });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "invalid_session" });
    expect(calls).toEqual([]);
  });

  it.each(["gpt-5.4", "ollama::local"])("rejects model injection %s before spawning or readiness calls", async (model) => {
    const { instance, recorder, calls } = await harness("happy", () => { throw new Error("must not probe"); });
    await instance.adapter.sendTurn({ threadId: "thread", text: "hello", model });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "invalid_model" });
    expect(calls).toEqual([]);
  });

  it.each(["auth_required", "unavailable"])("blocks turns when the host reports %s", async (state) => {
    const probes: unknown[] = [];
    const run: typeof execCli = (cli, args, opts, cb) => {
      probes.push({ cli, args });
      expect(opts.env?.COPILOT_GITHUB_TOKEN).toBeUndefined();
      cb(null, JSON.stringify({ state, message: "Complete local setup yourself", version: "1" }));
    };
    const { instance, recorder, calls } = await harness("happy", run);
    await instance.snapshot();
    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false, stopReason: state });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error", setup: true, message: "Complete local setup yourself",
    }));
    expect(calls).toEqual([]);
    expect(probes).toEqual(Array(2).fill({ cli: "C:\\Agent Path\\bugflow-agent.exe", args: ["status", "--json"] }));
  });

  it.each(["allow", "deny"] as const)("requires explicit %s once, even with fullAuto and remembered grants", async (behavior) => {
    const { instance, recorder, dump } = await harness("permission-always");
    expect(autoVerdict({ autoApprove: true, alwaysAllow: ["shell:echo"] }, "shell", "echo hi", {
      explicitApproval: instance.adapter.capabilities.explicitApprovals,
    }).approve).toBeNull();
    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const ask = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("thread", ask.requestId!, { behavior })).toBe(
      behavior === "allow" ? "allowed-once" : "rejected",
    );
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: behavior === "allow" ? "allow-once" : "reject" },
    });
  });

  it("cancels rather than translating allow-once into an allow-always grant", async () => {
    const { instance, recorder, dump } = await harness("permission-always-only");
    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const ask = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("thread", ask.requestId!, { behavior: "allow" })).toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"))).toEqual({ outcome: { outcome: "cancelled" } });
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "request.resolved", behavior: "deny" }));
  });

  it("sends cancellation as a notification and consumes the cancelled prompt result", async () => {
    const { instance, recorder, methods, closed } = await harness("cancel-result");
    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    await recorder.until((e) => e.type === "content.delta");
    await instance.adapter.interruptTurn("thread");
    expect(await recorder.until((e) => e.type === "turn.completed", 3000)).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(methods()).toContain("session/cancel");
    await Promise.all(closed);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("disposes only the bridge process it spawned", async () => {
    const { instance, recorder, calls, closed, children } = await harness("cancel-result");
    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    await recorder.until((e) => e.type === "content.delta");
    await instance.dispose();
    await Promise.all(closed);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([["acp"]]);
  });
});
