import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let home: string;
let stderr = "";
const botSchema = z.object({
  id: z.string(),
  messages: z.array(z.object({
    card: z.object({
      requestId: z.string().optional(), answered: z.string().optional(), allowKey: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();
const responseSchema = z.object({
  instances: z.array(z.object({ instanceId: z.string() }).passthrough()).optional(),
  bots: z.array(botSchema).optional(),
  bot: botSchema.optional(),
  outcome: z.string().optional(),
  error: z.string().optional(),
  supported: z.boolean().optional(),
  installation: z.object({ state: z.string(), progress: z.number() }).passthrough().optional(),
});
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${BASE}${path}`, {
    method, headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: responseSchema.parse(await response.json()) };
};

describe("BugFlow backend governance wiring", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "roundtable-bugflow-api-"));
    const data = join(home, ".Roundtable");
    mkdirSync(data);
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        governed: {
          driver: "bugflowAgent", config: { cli: FAKE_CLI, fullAuto: true },
          environment: { FAKE_ACP_BUGFLOW_STATUS: "ready", FAKE_ACP_MODE: "permission-always" },
        },
        legacy: { driver: "geminiAgent", config: { cli: FAKE_CLI } },
      },
    }));
    // Simulate a previously persisted bot with both kinds of standing grant.
    writeFileSync(join(data, "bots.json"), JSON.stringify([{
      id: "governed-bot", threadId: "governed-thread", name: "BugFlow", title: "", description: "",
      notifications: false, color: "purple", unread: false, createdAt: 1,
      modelSelection: { instanceId: "governed", model: "bugflow-default" }, resumeCursors: {},
      autoApprove: true, alwaysAllow: ["shell:echo"], computer: "off",
    }]));
    child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
      },
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      expect((await fetch(`${BASE}/api/health`)).ok).toBe(true);
    }, { timeout: 20_000 });
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("exports fixed-model, explicit-permission and no-attachment capabilities to the UI", async () => {
    await expect.poll(async () => {
      const result = await api("GET", "/api/instances");
      return result.body.instances?.find((instance: { instanceId: string }) => instance.instanceId === "governed");
    }, { timeout: 10_000 }).toMatchObject({
      driverKind: "bugflowAgent", displayName: "BugFlow Agent", cliDefault: "bugflow-agent", cli: FAKE_CLI,
      models: { default: "bugflow-default", options: [{ id: "bugflow-default", label: "BugFlow (agent-controlled)" }] },
      capabilities: { customModels: false, explicitApprovals: true, files: false, images: false, agentsMcp: false },
    });
  });

  it("reports installer support without starting installation or the host", async () => {
    const result = await api("GET", "/api/bugflow/install");
    expect(result.status).toBe(200);
    expect(result.body.supported).toBe(process.platform === "win32");
    expect(result.body.installation).toMatchObject({ state: "idle", progress: 0 });
  });

  it.each([
    {}, { instanceId: "missing" }, { instanceId: "legacy" }, { instanceId: "__proto__" },
    { instanceId: "governed", source: "https://example.com/untrusted" },
    { instanceId: "governed", cli: "C:\\arbitrary\\overwrite.exe" },
    { instanceId: "governed", ref: "old-artifact" },
  ])("rejects invalid or client-controlled installation targets %j", async (body) => {
    expect((await api("POST", "/api/bugflow/install", body)).status).toBe(400);
    expect((await api("GET", "/api/bugflow/install")).body.installation?.state).toBe("idle");
  });

  it("rejects simple cross-origin form installation requests", async () => {
    const result = await fetch(`${BASE}/api/bugflow/install`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: '{"instanceId":"governed"}',
    });
    expect(result.status).toBe(415);
  });

  it("keeps a real permission card pending despite fullAuto, bot auto mode and a saved grant", async () => {
    expect((await api("POST", "/api/bots/governed-bot/messages", { text: "inspect" })).status).toBe(202);
    let requestId = "";
    await expect.poll(async () => {
      const response = await api("GET", "/api/bots");
      const bot = response.body.bots?.find((value) => value.id === "governed-bot");
      const card = bot?.messages?.find((message) =>
        message.card?.requestId && !message.card.answered)?.card;
      requestId = card?.requestId ?? "";
      return card;
    }, { timeout: 10_000 }).toMatchObject({ title: "Approval needed", options: ["Allow", "Deny"] });
    const response = await api("GET", "/api/bots");
    const bot = response.body.bots?.find((value) => value.id === "governed-bot");
    expect(bot?.messages?.find((message) => message.card?.requestId === requestId)?.card?.allowKey).toBeUndefined();
    expect((await api("POST", "/api/bots/governed-bot/always-allow", { allowKey: "shell:echo" })).status).toBe(400);
    const answered = await api("POST", "/api/bots/governed-bot/respond", { requestId, behavior: "allow" });
    expect(answered.status).toBe(200);
    expect(answered.body.outcome).toBe("allowed-once");
  });

  it.each([{ autoApprove: true }, { alwaysAllow: ["shell:echo"] }])("rejects persistent grants %j", async (patch) => {
    const result = await api("PATCH", "/api/bots/governed-bot", patch);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("explicit approval");
  });

  it.each(["gpt-5.4", "ollama::local"])("rejects forged model %s at the API", async (model) => {
    expect((await api("PATCH", "/api/bots/governed-bot", {
      modelSelection: { instanceId: "governed", model },
    })).status).toBe(400);
  });

  it("rejects file/image prompt markers before a governed turn", async () => {
    for (const text of ['<attached-file path="C:\\secret.txt" />', '<attached-image path="C:\\image.png" />']) {
      const result = await api("POST", "/api/bots/governed-bot/messages", { text });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("does not accept");
    }
  });

  it("preserves other providers' approval settings and clears them when switching to BugFlow", async () => {
    const created = await api("POST", "/api/bots");
    const id = created.body.bot!.id;
    const allowed = await api("PATCH", `/api/bots/${id}`, {
      modelSelection: { instanceId: "legacy", model: "default" }, autoApprove: true, alwaysAllow: ["shell:echo"],
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.bot).toMatchObject({ autoApprove: true, alwaysAllow: ["shell:echo"] });
    const switched = await api("PATCH", `/api/bots/${id}`, {
      modelSelection: { instanceId: "governed", model: "bugflow-default" },
    });
    expect(switched.status).toBe(200);
    expect(switched.body.bot).toMatchObject({ autoApprove: false, alwaysAllow: [] });
  });
});
