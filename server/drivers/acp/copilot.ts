// GitHub Copilot CLI over its public-preview ACP stdio server.
// `copilot --acp` works on old releases (including 0.0.420) and current ones;
// older releases reject the newer, optional `--stdio` disambiguation flag.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli, killCliTree, spawnCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_COPILOT_MODELS: ModelCatalog = {
  default: "claude-sonnet-4.6",
  options: [
    { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
};

const MODEL_ID = /^[a-z0-9][a-z0-9._:+/-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;
const ACP_MODEL_TIMEOUT_MS = 15_000;
const MODEL_CACHE_TTL_MS = 60_000;

type StoredCopilotUser = Record<string, string>;

interface StoredCopilotConfig {
  lastLoggedInUser?: StoredCopilotUser;
  lastloggedinuser?: StoredCopilotUser;
  loggedInUsers?: StoredCopilotUser[];
  loggedinusers?: StoredCopilotUser[];
}

export type CopilotFailure = (Error & { code?: string | number }) | string | null | undefined;

function modelLabel(id: string): string {
  return id.split(/[-_/]+/g).filter(Boolean)
    .map((part) => (/^gpt$/i.test(part) ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Parse the wrapped quoted choices printed beside `copilot --help --model`.
 * Newer CLIs mention quoted 'auto' in prose without publishing a catalog, so
 * only an explicit `choices:` list is authoritative. */
export function decodeCopilotModelHelp(text: string): ModelCatalog | null {
  const marker = text.search(/--model\s+<model>/i);
  if (marker < 0) return null;
  const tail = text.slice(marker);
  const nextOption = tail.slice(1).search(/\r?\n\s{2,}--[a-z]/i);
  const block = nextOption < 0 ? tail : tail.slice(0, nextOption + 1);
  if (!/\bchoices\s*:/i.test(block)) return null;
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(/["']([^"']+)["']/g)) {
    const id = match[1]?.trim() ?? "";
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const fallback = STATIC_COPILOT_MODELS.options.find((option) => option.id === id);
    options.push(fallback ? { ...fallback } : { id, label: modelLabel(id) });
  }
  if (!options.length) return null;
  return { default: options[0]!.id, options };
}

/** Decode the account- and policy-specific model list returned by ACP
 * `session/new`. Unlike CLI help, this excludes models the user cannot use. */
export function decodeCopilotSessionModels(value: unknown): ModelCatalog | null {
  if (!value || typeof value !== "object") return null;
  const models = (value as { models?: unknown }).models;
  if (!models || typeof models !== "object") return null;
  const available = (models as { availableModels?: unknown }).availableModels;
  if (!Array.isArray(available)) return null;

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const entry of available) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { modelId?: unknown; name?: unknown };
    const id = typeof row.modelId === "string" ? row.modelId.trim() : "";
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : modelLabel(id);
    options.push({ id, label });
  }
  if (!options.length) return null;

  const current = (models as { currentModelId?: unknown }).currentModelId;
  const defaultId = typeof current === "string" && options.some((option) => option.id === current)
    ? current
    : options[0]!.id;
  return { default: defaultId, options };
}

/** Ask Copilot's ACP server for the same live catalog used by `/models`. */
export function probeCopilotAcpModels(
  cli: string,
  env: Record<string, string | undefined>,
  spawnProcess: typeof spawnCli = spawnCli,
): Promise<ModelCatalog | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      // SAFETY: env is assembled by the ACP core from process.env and the
      // instance's string-valued environment overrides.
      child = spawnProcess(cli, ["--acp"], { env: env as NodeJS.ProcessEnv, stdio: "pipe" });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let buffer = "";
    const finish = (catalog: ModelCatalog | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCliTree(child);
      resolve(catalog);
    };
    const send = (id: number, method: string, params: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    const timer = setTimeout(() => finish(null), ACP_MODEL_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) finish(null);
          else send(2, "session/new", { cwd: process.cwd(), mcpServers: [] });
        } else if (message.id === 2) {
          finish(message.error ? null : decodeCopilotSessionModels(message.result));
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));

    send(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

function execText(run: typeof execCli, cli: string, args: string[], env: Record<string, string | undefined>) {
  return new Promise<string | null>((resolve) => {
    // SAFETY: childEnv starts as process.env plus string-valued instance env;
    // ACP transforms only add or delete string-valued environment keys.
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env as NodeJS.ProcessEnv }, (err, stdout) =>
      resolve(err ? null : String(stdout ?? "")));
  });
}

export async function fetchCopilotModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
  spawnProcess: typeof spawnCli = spawnCli,
): Promise<ModelCatalog> {
  // Start the help fallback at the same time as the account-specific ACP
  // probe. A CLI that accepts `--acp` but never completes the handshake can
  // consume the full 15-second ACP deadline; starting the 8-second fallback
  // only afterwards made desktop startup exceed Electron's host deadline.
  const [session, help] = await Promise.all([
    probeCopilotAcpModels(cli, env, spawnProcess),
    execText(run, cli, ["--help"], env),
  ]);
  if (session) return session;
  const live = help ? decodeCopilotModelHelp(help) : null;
  if (!live) return STATIC_COPILOT_MODELS;
  const configured = env.COPILOT_MODEL?.trim();
  if (configured && MODEL_ID.test(configured) && !live.options.some((option) => option.id === configured)) {
    live.options.push({ id: configured, label: modelLabel(configured), custom: true });
  }
  if (configured && live.options.some((option) => option.id === configured)) live.default = configured;
  return live;
}

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function hasStoredLogin(env: Record<string, string | undefined>): boolean {
  const root = env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".copilot");
  const path = join(root, "config.json");
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const parsed: StoredCopilotConfig = JSON.parse(text);
    const last = parsed.lastLoggedInUser ?? parsed.lastloggedinuser;
    if (last && Object.keys(last).length > 0) return true;
    const users = parsed.loggedInUsers ?? parsed.loggedinusers;
    if (users && (Array.isArray(users) ? users.length > 0 : Object.keys(users).length > 0)) return true;
  } catch {
    // A malformed config is not proof of a usable keychain login.
  }
  return false;
}

function hasGhCliLogin(env: Record<string, string | undefined>): boolean {
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    env.GH_CONFIG_DIR ? join(env.GH_CONFIG_DIR, "hosts.yml") : "",
    env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "gh", "hosts.yml") : "",
    env.APPDATA ? join(env.APPDATA, "GitHub CLI", "hosts.yml") : "",
    join(home, ".config", "gh", "hosts.yml"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const githubBlock = text.match(/(?:^|\r?\n)github\.com:\s*(?:\r?\n)([\s\S]*?)(?=\r?\n[^\s]|\s*$)/i)?.[1] ?? text;
      if (/^\s*oauth_token:\s*["']?[^"'\s\r\n]+/im.test(githubBlock)) return true;
    } catch {
      // Unreadable or malformed config should not break provider probing.
    }
  }
  return false;
}

async function hasGhCliStatus(
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return (await execText(run, "gh", ["auth", "status", "--hostname", "github.com"], env)) !== null;
}

/** The actual OAuth secret stays in the OS keychain; the ACP turn remains the
 * authority on token expiry. This snapshot only detects stored user metadata. */
export async function copilotIsAuthenticated(
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  if (
    nonBlank(env.COPILOT_GITHUB_TOKEN) || nonBlank(env.GH_TOKEN) || nonBlank(env.GITHUB_TOKEN)
    || nonBlank(env.COPILOT_PROVIDER_BASE_URL) || hasStoredLogin(env) || hasGhCliLogin(env)
  ) return true;
  return hasGhCliStatus(env, run);
}

export function classifyCopilotError(error: CopilotFailure): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error instanceof Error ? error.code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (/unauthoriz|unauthenticated|not signed in|not logged in|authentication required|invalid.*token/.test(blob))
    return "invalid_credentials";
  if (/copilot.*(subscription|plan).*(inactive|expired|required)|no active copilot subscription/.test(blob))
    return "inactive_subscription";
  if (/rate limit|quota|premium requests? limit|region.*not supported/.test(blob))
    return "quota_or_region_restriction";
  return undefined;
}

const support = (run: typeof execCli, spawnProcess: typeof spawnCli): AcpSupport => {
  const modelCache = new WeakMap<object, { catalog: ModelCatalog; expiresAt: number }>();
  const resolveModels = async (environment: Record<string, string | undefined>, config: { cli: string }) => {
    const cachedModels = modelCache.get(config);
    if (cachedModels && cachedModels.expiresAt > Date.now()) return cachedModels.catalog;
    const catalog = await fetchCopilotModels(config.cli || "copilot", environment, run, spawnProcess);
    modelCache.set(config, { catalog, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
    return catalog;
  };
  return {
    driverKind: "copilotAgent",
    displayName: "Github Copilot cli",
    models: STATIC_COPILOT_MODELS,
    defaultCli: "copilot",
    nativeSource: "copilot.acp",
    loginNote: "Github Copilot cli is not signed in — run `copilot login` in a terminal",
    install: {
      command: {
        darwin: "brew install --cask copilot-cli",
        linux: "curl -fsSL https://gh.io/copilot-install | bash",
        win32: "winget install GitHub.Copilot",
      },
      docsUrl: "https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
      signInCommand: "copilot login",
    },
    resolveModels,
    spawnArgs: (config, turn) => [
      ...(config.fullAuto ? ["--allow-all"] : []),
      ...(turn.model ? ["--model", turn.model] : []),
      "--acp",
    ],
    credentialEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_API_KEY"],
    pickAuthMethod: () => null,
    authFailure: "continue",
    isAuthenticated: (env) => copilotIsAuthenticated(env, run),
    classifyError: (error) => {
      // SAFETY: classification only stringifies the value and reads Error fields;
      // arbitrary thrown values fit this deliberately closed adapter.
      return classifyCopilotError(error as CopilotFailure);
    },
    async configureSession({ request, sessionId, turn }) {
      if (!turn.model) return;
      try {
        await request("session/set_model", { sessionId, modelId: turn.model });
      } catch (error) {
        // SAFETY: core.ts rejects ACP requests with Error objects; JSON-RPC
        // errors attach an optional numeric code to that Error.
        const err = error as Error & { code?: unknown };
        // argv already pins the model on CLIs without this optional ACP method.
        if (err.code === -32601 || err.code === -32602) return;
        throw error;
      }
    },
    buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  };
};

export function createCopilotAgentDriver(run: typeof execCli = execCli, spawnProcess: typeof spawnCli = spawnCli) {
  return createAcpDriver(support(run, spawnProcess));
}

export const CopilotAgentDriver = createCopilotAgentDriver();
