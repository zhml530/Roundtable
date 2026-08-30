// Shared provisioning and shell contract for the cloud computer's X11 and
// Chrome DevTools controls. The box command API is the transport boundary.
export const REMOTE_CDP_HELPER = "/opt/ogb/Roundtable-cdp.mjs";

const CDP_HELPER_SOURCE = String.raw`const [action, encoded = ""] = process.argv.slice(2);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8") || "{}");
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!page) throw new Error("no debuggable browser page");
if (input.url && page.url !== input.url) throw new Error("page changed; take a new browser snapshot");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result ?? {});
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const refId = (value) => {
  const match = /^b(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error("invalid or stale browser ref; take a new snapshot");
  return Number(match[1]);
};
if (action === "snapshot") {
  await send("Accessibility.enable");
  const { nodes = [] } = await send("Accessibility.getFullAXTree", { depth: 14 });
  const useful = new Set(["button", "checkbox", "combobox", "heading", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
  const elements = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "").toLowerCase();
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const backend = Number(node.backendDOMNodeId ?? 0);
    if (!backend || !useful.has(role) || (!name && role !== "textbox" && role !== "searchbox")) continue;
    const disabled = node.properties?.some((property) => property.name === "disabled" && property.value?.value === true) ?? false;
    elements.push({ ref: "b" + backend, role, name: name || "unnamed", disabled });
    if (elements.length >= 250) break;
  }
  process.stdout.write(JSON.stringify({ title: String(page.title ?? "").slice(0, 200), url: page.url, elements }));
} else if (action === "click") {
  const backendNodeId = refId(input.ref);
  const { model } = await send("DOM.getBoxModel", { backendNodeId });
  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("element is not visible; take a new snapshot");
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "fill") {
  const backendNodeId = refId(input.ref);
  await send("DOM.focus", { backendNodeId });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await send("Input.insertText", { text: String(input.text ?? "") });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else {
  throw new Error("unknown browser action");
}
socket.close();`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Idempotent setup for the retained X11 and Chrome DevTools controls. */
export function remoteComputerBootstrapCommand(botName: string): string {
  const helper = Buffer.from(CDP_HELPER_SOURCE).toString("base64");
  const safeName = botName.replace(/["'\\]/g, "");
  return [
    "if ! command -v xdotool >/dev/null || ! command -v convert >/dev/null; then sudo apt-get update -qq || true; sudo apt-get install -y -qq gnome-screenshot xclip wmctrl xdotool imagemagick scrot >/dev/null 2>&1 || true; fi",
    "sudo mkdir -p /opt/ogb/run",
    `printf %s ${shellQuote(helper)} | base64 -d | sudo tee ${REMOTE_CDP_HELPER} >/dev/null`,
    `sudo chmod 0755 ${REMOTE_CDP_HELPER}`,
    'pkill -f "^/opt/ogb/venv/bin/python -m computer_server( |$)" >/dev/null 2>&1 || true',
    `tmux has-session -t work 2>/dev/null || tmux new-session -d -s work 'echo; echo "  ▦ ${safeName}'"'"'s computer — Roundtable"; echo; exec bash -i'`,
    "echo bootstrapped",
  ].join("\n");
}

export function semanticBrowserCommand(action: "snapshot" | "click" | "fill", input: unknown): string {
  const encoded = Buffer.from(JSON.stringify(input ?? {})).toString("base64url");
  return `node ${REMOTE_CDP_HELPER} ${action} ${shellQuote(encoded)}`;
}

