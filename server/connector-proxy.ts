// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class Roundtable chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { localRpcRequest, localRpcJson } from "./local-rpc.ts";

type Json = Record<string, unknown>;

const UPSTREAM_PATH = process.env.OMB_CONNECTOR_UPSTREAM_PATH ?? "";
const HARNESS_PIPE = process.env.OMB_HARNESS_PIPE ?? "";
const UPSTREAM_URL = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS_URL = process.env.OMB_HARNESS_URL ?? "";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

async function relay(message: Json): Promise<Json | null> {
  const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...upstreamHeaders,
      ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
  };
  if (UPSTREAM_PATH && HARNESS_PIPE) {
    const response = await localRpcRequest(HARNESS_PIPE, {
      path: UPSTREAM_PATH, method: "POST", headers, body: JSON.stringify(message),
    });
    const nextSession = response.headers["mcp-session-id"];
    if (nextSession) upstreamSessionId = nextSession;
    if (response.status < 200 || response.status >= 300) throw new Error(`connector service returned ${response.status}`);
    return parseUpstream(new TextDecoder().decode(response.body), message.id);
  }
  if (!UPSTREAM_URL) throw new Error("connected apps are unavailable");
  const response = await fetch(UPSTREAM_URL, {
    method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(10 * 60_000),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await response.text(), message.id);
}

function connectorAdds(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  return [...new Set(toolkits.flatMap((item) => {
    if (typeof item === "string") return [item.toLowerCase()];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown };
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    const action = String(row.action ?? "add").toLowerCase();
    return typeof slug === "string" && ["add", "connect", "initiate"].includes(action) ? [slug.toLowerCase()] : [];
  }))];
}

async function showConnectorCards(slugs: string[]): Promise<void> {
  const path = "/api/internal/connectors/request";
  const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  const body = JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, slugs, resumeKey: randomUUID() });
  if (HARNESS_PIPE) {
    await localRpcJson(HARNESS_PIPE, { path, method: "POST", headers, body });
    return;
  }
  if (!HARNESS_URL) throw new Error("the Roundtable orchestration channel is unavailable");
  const response = await fetch(HARNESS_URL + path, { method: "POST", headers, body });
  if (!response.ok) throw new Error(`could not show connection card (HTTP ${response.status})`);
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const slugs = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (slugs.length) {
      await showConnectorCards(slugs);
      send(textResult(
        id,
        `Roundtable showed the user a secure connection card for ${slugs.join(", ")}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "Roundtable is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  const response = await relay(message);
  if (response && id !== undefined) send(response);
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    message = JSON.parse(trimmed) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id !== undefined) {
      send(textResult(message.id, error instanceof Error ? error.message : String(error), true));
    }
  });
});
input.on("close", () => process.exit(0));

