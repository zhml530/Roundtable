import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wayland = process.env.OMB_SMOKE_WAYLAND === "1";
const executable = path.resolve(
  process.env.OMB_SMOKE_EXECUTABLE ?? path.join(root, "release", "linux-unpacked", "Roundtable"),
);
if (!existsSync(executable)) throw new Error(`[smoke-linux-package] missing executable: ${executable}`);

const sandbox = mkdtempSync(path.join(tmpdir(), "omb-linux-smoke-"));
const home = path.join(sandbox, "home");
const xdgConfig = path.join(sandbox, "config");
const xdgRuntime = path.join(sandbox, "runtime");
mkdirSync(home, { recursive: true });
mkdirSync(xdgConfig, { recursive: true });
mkdirSync(xdgRuntime, { recursive: true, mode: 0o700 });
chmodSync(xdgRuntime, 0o700);

let brokerRequests = 0;
const brokerSockets = new Set();
const slowBroker = createServer(() => {
  brokerRequests += 1;
});
slowBroker.on("connection", (socket) => {
  brokerSockets.add(socket);
  socket.once("close", () => brokerSockets.delete(socket));
});
await new Promise((resolve, reject) => {
  slowBroker.once("error", reject);
  slowBroker.listen(0, "127.0.0.1", resolve);
});
const brokerAddress = slowBroker.address();
if (!brokerAddress || typeof brokerAddress === "string") {
  throw new Error("could not start the deterministic slow Composio broker");
}

const desktopEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_RUNTIME_DIR: xdgRuntime,
  XDG_SESSION_TYPE: wayland ? "wayland" : "x11",
  XDG_CURRENT_DESKTOP: "GNOME",
  OMB_COMPOSIO_BROKER_URL: `http://127.0.0.1:${brokerAddress.port}`,
  OMB_SMOKE_TEST: "1",
};
if (wayland) desktopEnv.WAYLAND_DISPLAY = "wayland-smoke";
else delete desktopEnv.WAYLAND_DISPLAY;

let output = "";
let smokeResult = null;
const electronArgs = ["--password-store=basic"];
if (wayland) electronArgs.push("--ozone-platform=x11");
const child = spawn(executable, electronArgs, {
  cwd: root,
  detached: true,
  env: desktopEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
    if (match && !smokeResult) smokeResult = JSON.parse(match[1]);
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const childRunning = () => child.exitCode === null && child.signalCode === null;

async function until(probe, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (!childRunning()) throw new Error(`Electron exited while waiting for ${description}.\n${output}`);
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}.\n${output}`);
}

async function stopProcess() {
  if (!childRunning()) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}

try {
  const result = await until(async () => smokeResult, "the packaged renderer smoke result");
  const { capabilities, displayMediaRequests, hardwareAccelerationEnabled, health, title } = result;
  if (health?.app !== "Roundtable" || health.static !== true) {
    throw new Error(`unexpected embedded health response: ${JSON.stringify(health)}`);
  }
  if (!String(title).includes("Roundtable")) throw new Error(`unexpected renderer title: ${title}`);
  if (capabilities.host.platform !== "linux") throw new Error("renderer did not report Linux");
  if (capabilities.host.session !== (wayland ? "wayland" : "x11")) {
    throw new Error(`renderer did not report the ${wayland ? "Wayland" : "X11"} contract`);
  }
  const expectedPreview = wayland ? "portal-picker" : "direct";
  if (!capabilities.screenPreview.available || capabilities.screenPreview.interaction !== expectedPreview) {
    throw new Error(`${wayland ? "Wayland" : "X11"} screen preview capability was not available`);
  }
  if (capabilities.dictation.available) throw new Error("dictation must be unavailable on Linux");
  if (hardwareAccelerationEnabled !== false) {
    throw new Error("Linux package did not disable hardware acceleration before startup");
  }
  if (displayMediaRequests !== 0) throw new Error("launch triggered display capture without user intent");
  await until(async () => brokerRequests > 0, "the optional slow-broker request");
  await until(async () => !childRunning(), "normal Electron shutdown");
  console.log(`[smoke-linux-package] OK (${wayland ? "GNOME/Wayland" : path.basename(executable)}): renderer, preload, harness, and shutdown`);
} finally {
  await stopProcess();
  for (const socket of brokerSockets) socket.destroy();
  await new Promise((resolve) => slowBroker.close(resolve));
  if (process.env.OMB_KEEP_SMOKE_DIR !== "1") rmSync(sandbox, { recursive: true, force: true });
  else console.log(`[smoke-linux-package] kept ${sandbox}`);
}
