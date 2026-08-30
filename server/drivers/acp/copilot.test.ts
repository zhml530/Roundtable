import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import { resetPathCacheForTests } from "../../env-path.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  classifyCopilotError,
  copilotIsAuthenticated,
  CopilotAgentDriver,
  decodeCopilotModelHelp,
  decodeCopilotSessionModels,
  fetchCopilotModels,
  probeCopilotAcpModels,
} from "./copilot.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("GitHub Copilot ACP support", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.XAI_API_KEY;
    delete process.env.OMB_EXTRA_PATH;
    resetPathCacheForTests();
    for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
  });

  it("parses wrapped model choices from copilot --help", () => {
    const catalog = decodeCopilotModelHelp(`
  --model <model>  Set the AI model to use (choices:
                   "claude-sonnet-4.6", "gpt-5.3-codex",
                   "brand-new-model")
  --no-color        Disable color
`);
    expect(catalog).toEqual({
      default: "claude-sonnet-4.6",
      options: [
        { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
        { id: "brand-new-model", label: "Brand New Model" },
      ],
    });
    expect(decodeCopilotModelHelp("Usage: copilot")).toBeNull();
  });

  it("ignores quoted auto in Copilot 1.0.82 prose so discovery uses the fallback catalog", () => {
    expect(decodeCopilotModelHelp(`
  --model <model>  Set the AI model to use (use 'auto' to
                   let Copilot pick automatically)
  --mouse[=value]  Enable mouse support in alt screen mode
    `)).toBeNull();
  });

  it("decodes only the account-specific models advertised by an ACP session", () => {
    expect(decodeCopilotSessionModels({
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { modelId: "grok-4.6", name: "Grok 4.6" },
        ],
      },
    })).toEqual({
      default: "gpt-5.6-sol",
      options: [
        { id: "auto", label: "Auto" },
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "grok-4.6", label: "Grok 4.6" },
      ],
    });
  });

  it("probes Copilot's ACP session model catalog", async () => {
    ensureDirs();
    process.env.OMB_EXTRA_PATH = dirname(process.execPath);
    resetPathCacheForTests();
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await probeCopilotAcpModels(FAKE_CLI, {
      ...process.env,
      FAKE_ACP_SESSION_MODELS: "auto|Auto,gpt-5.6-sol|GPT-5.6 Sol,grok-4.6|Grok 4.6",
    });
    expect(catalog).toEqual({
      default: "auto",
      options: [
        { id: "auto", label: "Auto" },
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "grok-4.6", label: "Grok 4.6" },
      ],
    });
  });

  it("starts the help fallback without waiting for a stalled ACP probe", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;

    let helpCallback: ((error: Error | null, stdout: string) => void) | undefined;
    const run = ((_cli, args, _options, callback) => {
      expect(args).toEqual(["--help"]);
      helpCallback = callback;
      return child;
    }) as typeof import("../../procs.ts").execCli;
    const spawnProcess = (() => child) as unknown as typeof import("../../procs.ts").spawnCli;

    const catalogPromise = fetchCopilotModels("copilot", {}, run, spawnProcess);
    expect(helpCallback).toBeTypeOf("function");

    helpCallback!(null, `
  --model <model>  Set the AI model to use (choices: "auto", "gpt-5.6-sol")
  --no-color        Disable color
    `);
    child.emit("error", new Error("ACP handshake stalled"));

    await expect(catalogPromise).resolves.toEqual({
      default: "auto",
      options: [
        { id: "auto", label: "Auto" },
        { id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
      ],
    });
  });

  it("detects token, BYOK, and stored-login metadata without reading a secret", async () => {
    expect(await copilotIsAuthenticated({ COPILOT_GITHUB_TOKEN: "token" })).toBe(true);
    expect(await copilotIsAuthenticated({ COPILOT_PROVIDER_BASE_URL: "http://localhost:11434" })).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "omb-copilot-auth-"));
    scratchDirs.push(root);
    writeFileSync(
      join(root, "config.json"),
      '// User settings belong in settings.json.\n{"lastLoggedInUser":{"login":"octocat"}}',
    );
    expect(await copilotIsAuthenticated({ COPILOT_HOME: root })).toBe(true);
    expect(await copilotIsAuthenticated({ COPILOT_HOME: join(root, "missing") })).toBe(false);
    const ghRoot = mkdtempSync(join(tmpdir(), "omb-gh-auth-"));
    scratchDirs.push(ghRoot);
    writeFileSync(
      join(ghRoot, "hosts.yml"),
      "github.com:\n    user: octocat\n    oauth_token: gho_testtoken\n    git_protocol: https\n",
    );
    expect(await copilotIsAuthenticated({ GH_CONFIG_DIR: ghRoot })).toBe(true);
  });

  it("accepts an authenticated gh session when token metadata is unavailable", async () => {
    const authed = await copilotIsAuthenticated(
      {},
      (_cli, _args, _opts, cb) => cb(null, "Logged in to github.com as octocat"),
    );
    expect(authed).toBe(true);

    const notAuthed = await copilotIsAuthenticated({}, (_cli, _args, _opts, cb) => cb(new Error("not logged in"), ""));
    expect(notAuthed).toBe(false);
  });

  it("classifies auth, subscription, and quota failures", () => {
    expect(classifyCopilotError(new Error("Authentication required"))).toBe("invalid_credentials");
    expect(classifyCopilotError(new Error("No active Copilot subscription"))).toBe("inactive_subscription");
    expect(classifyCopilotError(new Error("Premium requests limit reached"))).toBe("quota_or_region_restriction");
    expect(classifyCopilotError(new Error("model not found"))).toBeUndefined();
  });

  it("declares setup metadata and backwards-compatible defaults", () => {
    expect(CopilotAgentDriver.driverKind).toBe("copilotAgent");
    expect(CopilotAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "copilot",
      fullAuto: false,
      workspace: undefined,
    });
    expect(CopilotAgentDriver.install?.command?.win32).toContain("GitHub.Copilot");
    expect(CopilotAgentDriver.install?.signInCommand).toBe("copilot login");
  });

  it("runs a model-pinned ACP turn, isolates credentials, and applies fullAuto", async () => {
    ensureDirs();
    process.env.OMB_EXTRA_PATH = dirname(process.execPath);
    resetPathCacheForTests();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-copilot-turn-"));
    scratchDirs.push(scratch);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.COPILOT_GITHUB_TOKEN = "copilot-should-keep";
    process.env.XAI_API_KEY = "xai-should-not-leak";

    const instance = await CopilotAgentDriver.create({
      instanceId: "copilot",
      displayName: "GitHub Copilot",
      environment: { COPILOT_GITHUB_TOKEN: "copilot-should-keep" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-copilot", text: "hi", model: "gpt-5.3-codex" });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual(["--allow-all", "--model", "gpt-5.3-codex", "--acp"]);
      expect(seen.env.COPILOT_GITHUB_TOKEN).toBe("copilot-should-keep");
      expect(seen.env.XAI_API_KEY).toBeUndefined();
      expect(recorder.events.some((event) => event.type === "turn.completed" && event.ok)).toBe(true);

      expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toContainEqual({
        method: "session/set_model",
        params: { sessionId: "fake-acp-session", modelId: "gpt-5.3-codex" },
      });
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
