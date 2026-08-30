import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(process.argv[2] ?? path.join(root, "release"));

function fail(message) {
  throw new Error(`[verify-linux-package] ${message}`);
}

function exactlyOne(suffix) {
  const matches = readdirSync(releaseDir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(releaseDir, name));
  if (matches.length !== 1) fail(`expected exactly one ${suffix} artifact, found ${matches.length}`);
  return matches[0];
}

function requireFile(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`missing file: ${file}`);
}

function requireExecutable(file) {
  requireFile(file);
  try {
    accessSync(file, constants.X_OK);
  } catch {
    fail(`not executable: ${file}`);
  }
}

function requirePackagedApp(resources) {
  for (const relative of ["app.asar", "ui/index.html", "server/ipc-entry.js"]) {
    requireFile(path.join(resources, relative));
  }
}

const appImage = exactlyOne(".AppImage");
const deb = exactlyOne(".deb");
const unpacked = path.join(releaseDir, "linux-unpacked");

requireExecutable(appImage);
requireExecutable(path.join(unpacked, "Roundtable"));
requirePackagedApp(path.join(unpacked, "resources"));

const fields = execFileSync(
  "dpkg-deb",
  ["--field", deb, "Package", "Version", "Architecture", "Maintainer", "Section", "Priority"],
  { encoding: "utf8" },
);
for (const expected of [
  "Package: Roundtable",
  "Architecture: amd64",
  "Maintainer: Milind Soni",
  "Section: utils",
  "Priority: optional",
]) {
  if (!fields.includes(expected)) fail(`DEB metadata is missing ${JSON.stringify(expected)}`);
}

const extracted = mkdtempSync(path.join(tmpdir(), "omb-deb-verify-"));
try {
  execFileSync("dpkg-deb", ["--extract", deb, extracted]);
  requirePackagedApp(path.join(extracted, "opt", "Roundtable", "resources"));
  const desktopFile = path.join(
    extracted,
    "usr",
    "share",
    "applications",
    "com.Roundtable.app.desktop",
  );
  const scalableIcon = path.join(
    extracted,
    "usr",
    "share",
    "icons",
    "hicolor",
    "scalable",
    "apps",
    "Roundtable.svg",
  );
  requireFile(desktopFile);
  requireFile(scalableIcon);
  const desktop = readFileSync(desktopFile, "utf8");
  for (const expected of [
    "Name=Roundtable",
    "Exec=/opt/Roundtable/Roundtable %U",
    "Icon=Roundtable",
    "StartupWMClass=com.Roundtable.app",
    "Categories=Utility;",
  ]) {
    if (!desktop.includes(expected)) fail(`desktop entry is missing ${JSON.stringify(expected)}`);
  }
  execFileSync("desktop-file-validate", [desktopFile], { stdio: "inherit" });
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

const appImageExtracted = mkdtempSync(path.join(tmpdir(), "omb-appimage-verify-"));
try {
  const offset = execFileSync(appImage, ["--appimage-offset"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (!/^\d+$/.test(offset)) fail(`AppImage returned an invalid SquashFS offset: ${offset}`);
  const squashRoot = path.join(appImageExtracted, "squashfs-root");
  execFileSync(
    "unsquashfs",
    ["-no-progress", "-offset", offset, "-d", squashRoot, appImage],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 },
  );
  requirePackagedApp(path.join(squashRoot, "resources"));
} finally {
  rmSync(appImageExtracted, { recursive: true, force: true });
}

console.log(`[verify-linux-package] OK\n- ${path.basename(appImage)}\n- ${path.basename(deb)}`);
