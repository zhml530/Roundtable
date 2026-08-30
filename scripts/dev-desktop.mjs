import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitePackagePath = require.resolve("vite/package.json");
const vitePackage = require(vitePackagePath);
const viteBin = join(dirname(vitePackagePath), vitePackage.bin.vite);
const electronBin = require("electron");
const port = Number(process.env.OMB_UI_PORT) || 5199;
const devUrl = process.env.ELECTRON_START_URL || `http://127.0.0.1:${port}`;

function run(command, args, env = process.env) {
  return spawn(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
}

function exitOf(child, name) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ name, code, signal }));
  });
}

async function waitForVite(url, viteExit, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      fetch(url, { signal: AbortSignal.timeout(500) })
        .then((response) => ({ kind: response.ok ? "ready" : "retry" }))
        .catch(() => ({ kind: "retry" })),
      viteExit.then((exit) => ({ kind: "exit", exit })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "retry" }), 150)),
    ]);
    if (outcome.kind === "ready") return;
    if (outcome.kind === "exit") {
      const { code, signal } = outcome.exit;
      throw new Error(`Vite exited before becoming ready (${signal ?? `code ${code}`})`);
    }
  }
  throw new Error(`Vite did not become ready at ${url} within ${timeoutMs / 1000} seconds`);
}

const vite = run(process.execPath, [viteBin]);
const viteExit = exitOf(vite, "Vite");
let electron = null;

const stop = () => {
  electron?.kill();
  vite.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await waitForVite(devUrl, viteExit);
  console.log(`[desktop] Vite ready at ${devUrl}; starting Electron`);
  electron = run(electronBin, [root], { ...process.env, ELECTRON_START_URL: devUrl });
  const result = await Promise.race([exitOf(electron, "Electron"), viteExit]);
  if (result.name === "Vite" && electron.exitCode === null) {
    electron.kill();
    throw new Error(`Vite exited while Electron was running (${result.signal ?? `code ${result.code}`})`);
  }
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
} catch (error) {
  console.error(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  stop();
}
