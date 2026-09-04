import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "release", "channel-validation", "win-unpacked", "Roundtable.exe");
if (!existsSync(executable)) throw new Error("Build the channel-validation Windows directory first");
const sandbox = mkdtempSync(path.join(tmpdir(), "roundtable-channel-desktop-"));
const data = path.join(sandbox, "data");
mkdirSync(data);
writeFileSync(path.join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }));
const env = { ...process.env, OMB_DATA_DIR: data, USERPROFILE: sandbox, HOME: sandbox,
  APPDATA: path.join(sandbox, "appdata"), LOCALAPPDATA: path.join(sandbox, "localappdata"),
  OMB_SMOKE_TEST: "1", OMB_COMPOSIO_BROKER_URL: "http://127.0.0.1:1" };
delete env.ELECTRON_RUN_AS_NODE;
let output = "";
const child = spawn(executable, [`--user-data-dir=${path.join(sandbox, "chromium")}`], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
const timer = setTimeout(() => { child.kill(); }, 45_000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const match = output.match(/\[smoke\] renderer-ready (\{.*\})/);
  writeFileSync(path.join(sandbox, "smoke.log"), output);
  if (!match) throw new Error(`Desktop smoke failed (${code}); log: ${path.join(sandbox, "smoke.log")}\n${output.slice(-3000)}`);
  const result = JSON.parse(match[1]);
  if (result.health.app !== "Roundtable" || result.health.transport !== "ipc" || !result.location.startsWith("file:")) throw new Error("Packaged renderer/IPC health failed");
  console.log(JSON.stringify({ result: "passed", packagedRenderer: result.location, ipcHealth: result.health.transport, log: path.join(sandbox, "smoke.log") }));
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
