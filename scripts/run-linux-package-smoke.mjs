import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixName = "omb-linux-smoke-runtime-";
const appImages = readdirSync(path.join(root, "release")).filter((name) => name.endsWith(".AppImage"));
if (appImages.length !== 1) {
  throw new Error(`[run-linux-package-smoke] expected exactly one AppImage, found ${appImages.length}`);
}

const executables = [
  path.join(root, "release", "linux-unpacked", "Roundtable"),
  path.join(root, "release", appImages[0]),
];
if (process.env.OMB_SMOKE_INSTALLED_DEB === "1") executables.push("/opt/Roundtable/Roundtable");

for (const executable of executables) {
  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), prefixName));
  chmodSync(runtimeDirectory, 0o700);
  const result = spawnSync(
    "dbus-run-session",
    ["--", "xvfb-run", "-a", process.execPath, path.join(root, "scripts", "smoke-linux-package.mjs")],
    {
      cwd: root,
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, OMB_SMOKE_EXECUTABLE: executable },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[run-linux-package-smoke] failed runtime kept at ${runtimeDirectory}`);
    process.exit(result.status ?? 1);
  }
  rmSync(runtimeDirectory, { recursive: true, force: true });
}
