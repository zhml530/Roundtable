import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BugFlowInstallStatus } from "../shared/bugflow-install.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export const BUGFLOW_SOURCE = "https://skype.visualstudio.com/DefaultCollection/SCC/_git/media_intelligence_service";
// Source PR 1552317 merged here; repository main does not contain the package.
export const BUGFLOW_SOURCE_REF = "refs/heads/canranjin/bug_flow_dev";
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const provenanceSchema = z.object({
  schema_version: z.literal(1),
  requested_ref: z.literal(BUGFLOW_SOURCE_REF),
  source: z.object({
    kind: z.literal("clean-checkout"),
    commit_identifies_source: z.literal(true),
    base_commit: z.string().regex(COMMIT),
  }),
  artifact: z.object({
    name: z.literal("BugFlow.exe"),
    size_bytes: z.number().int().positive(),
    sha256: z.string().regex(HASH),
  }),
});

export interface InstallCommand {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}
export type InstallRunner = (command: InstallCommand) => Promise<string>;

/** Commands never launch an interactive shell. Bound both time and output. */
export const runInstallCommand: InstallRunner = ({ program, args, cwd, env, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Installation cancelled during shutdown."));
    const child = spawnCli(program, args, { cwd, env, stdio: "pipe" });
    child.stdin.end();
    let stdout = "";
    let bytes = 0;
    let failure: Error | undefined;
    const abort = () => {
      failure = new Error("Installation cancelled during shutdown.");
      killCliTree(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new Error("Command timed out; check network access and build prerequisites before retrying.");
      killCliTree(child);
    }, timeoutMs);
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024 && !failure) {
        failure = new Error("Command output exceeded the installation limit.");
        killCliTree(child);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      count(chunk);
      if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8").slice(0, 64 * 1024 - stdout.length);
    });
    // Build output may contain private source URLs or credential diagnostics.
    // Do not publish it through the progress API or write it into public logs.
    child.stderr.on("data", count);
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = new Error(error.code === "ENOENT"
        ? "Required build tool was not found. Install Git and Python 3.12 x64, then reopen Roundtable."
        : "Could not start a build tool. Check local application-control policy and file permissions.");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Command exited ${code}. Check source access, package downloads and local build prerequisites. For Windows path-length failures, use a shorter Roundtable data directory. No login was started.`));
      else resolve(stdout.trim());
    });
  });

export function installerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
  for (const key of [
    "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME",
    "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PATHEXT",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_GUI_PROMPT: "false",
    PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function verifyBugFlowArtifact(directory: string, commit: string): Promise<string> {
  const provenance = provenanceSchema.parse(JSON.parse(await readFile(join(directory, "build-provenance.json"), "utf8")));
  if (provenance.source.base_commit !== commit) throw new Error("Build provenance does not match the freshly resolved source commit.");
  const exe = join(directory, "BugFlow.exe");
  const info = await stat(exe);
  if (!info.isFile() || info.size !== provenance.artifact.size_bytes || info.size < 1024 * 1024) {
    throw new Error("The build did not produce the expected standalone EXE.");
  }
  const hash = await sha256(exe);
  const sidecar = (await readFile(join(directory, "BugFlow.exe.sha256"), "utf8")).trim();
  if (hash !== provenance.artifact.sha256 || sidecar !== `${hash}  BugFlow.exe`) {
    throw new Error("The fresh EXE failed SHA256 verification.");
  }
  return hash;
}

interface InstallerOptions {
  root: string;
  configure: (instanceId: string, cli: string) => Promise<void>;
  platform?: NodeJS.Platform;
  run?: InstallRunner;
}

/** One fresh checkout and immutable installation directory per click. A failed
 * attempt never rewrites an old executable or invokes the persistent host. */
export class BugFlowInstaller {
  private current: BugFlowInstallStatus = { state: "idle", phase: "idle", message: "", progress: 0 };
  private work: Promise<void> | undefined;
  private busy = false;
  private closing = false;
  private controller = new AbortController();
  private readonly run: InstallRunner;
  private readonly options: InstallerOptions;
  constructor(options: InstallerOptions) {
    this.options = options;
    this.run = options.run ?? runInstallCommand;
  }
  status(): BugFlowInstallStatus { return { ...this.current }; }
  async wait(): Promise<BugFlowInstallStatus> { await this.work; return this.status(); }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.controller.abort();
    await this.work;
  }
  start(instanceId: string): BugFlowInstallStatus {
    if (this.closing) throw Object.assign(new Error("The installer is shutting down. Reopen Roundtable to install."), { status: 409 });
    if ((this.options.platform ?? process.platform) !== "win32") {
      throw Object.assign(new Error("The standalone BugFlow installer requires Windows."), { status: 400 });
    }
    if (this.busy) throw Object.assign(new Error("A BugFlow installation is already running."), { status: 409 });
    this.busy = true;
    this.controller = new AbortController();
    this.current = {
      state: "running", phase: "prerequisites", message: "Checking Git and Python 3.12 x64...",
      progress: 0, instanceId, attemptId: randomUUID(), startedAt: new Date().toISOString(),
    };
    this.work = this.install(instanceId, this.current.attemptId!);
    return this.status();
  }
  private phase(phase: string, message: string, progress: number) {
    this.current = { ...this.current, phase, message, progress };
  }
  private async install(instanceId: string, attemptId: string): Promise<void> {
    const root = this.options.root;
    const lockPath = join(root, "install.lock");
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let checkout: string | undefined;
    let deployed: string | undefined;
    let configured = false;
    try {
      await mkdir(root, { recursive: true });
      try { lock = await open(lockPath, "wx"); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error("Another installation holds install.lock. If Roundtable stopped during a build, close its build processes and remove that lock before retrying.");
        }
        throw error;
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, attemptId }));
      const env = installerEnvironment();
      const exec = (program: string, args: string[], cwd = root, timeoutMs = 60_000, environment = env) =>
        this.run({ program, args, cwd, timeoutMs, env: environment, signal: this.controller.signal });
      await exec("git", ["--version"]);
      const python = await exec("py", ["-3.12", "-c", "import sys,struct; assert sys.version_info[:2] == (3,12) and struct.calcsize('P') == 8; print(sys.executable)"]);
      if (!python || /[\r\n]/.test(python)) throw new Error("Python 3.12 x64 could not be located. Install its Windows launcher and reopen Roundtable.");
      checkout = join(root, "builds", attemptId);
      await mkdir(checkout, { recursive: true });
      this.phase("source", "Fetching the latest published BugFlow source (existing Git authorization required)...", 10);
      await exec("git", ["init", "--quiet", checkout]);
      await exec("git", ["-C", checkout, "config", "core.longpaths", "true"]);
      await exec("git", ["-C", checkout, "remote", "add", "origin", BUGFLOW_SOURCE]);
      await exec("git", ["-C", checkout, "sparse-checkout", "set", "BugFlow"]);
      await exec("git", ["-C", checkout, "fetch", "--quiet", "--depth=1", "--filter=blob:none", "--no-tags", "origin", BUGFLOW_SOURCE_REF], root, 10 * 60_000);
      const commit = await exec("git", ["-C", checkout, "rev-parse", "FETCH_HEAD^{commit}"]);
      if (!COMMIT.test(commit)) throw new Error("The published source ref did not resolve to a commit.");
      this.current.commit = commit;
      await exec("git", ["-C", checkout, "checkout", "--quiet", "--detach", commit], root, 10 * 60_000);
      await exec("git", ["-C", checkout, "ls-files", "--error-unmatch", "BugFlow/windows-agent/build.ps1", "BugFlow/windows-agent/pyproject.toml"]);
      const pkg = join(checkout, "BugFlow", "windows-agent");
      const venv = join(pkg, "build", "venv");
      const buildPython = join(venv, "Scripts", "python.exe");
      this.phase("dependencies", "Preparing a new isolated Python build environment...", 25);
      await exec(python, ["-m", "venv", venv], checkout, 3 * 60_000);
      await exec(buildPython, ["-m", "pip", "install", "-e", `${pkg}[build,test]`], checkout, 15 * 60_000);
      // Keep downloaded SDK assets separate from any running user's host/cache.
      const buildEnv = { ...env, LOCALAPPDATA: join(pkg, "build", "localappdata") };
      await mkdir(buildEnv.LOCALAPPDATA, { recursive: true });
      this.phase("runtime", "Downloading and verifying the package's pinned SDK runtime...", 40);
      await exec(buildPython, ["-m", "copilot", "download-runtime"], checkout, 10 * 60_000, buildEnv);
      this.phase("build", "Building a fresh self-contained BugFlow.exe. This can take several minutes...", 55);
      const powershell = join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      await exec(powershell, [
        "-NoProfile", "-NonInteractive", "-File", join(pkg, "build.ps1"),
        "-Python", buildPython, "-ExpectedCommit", commit, "-SourceRef", BUGFLOW_SOURCE_REF, "-RequireCleanSource",
      ], checkout, 20 * 60_000, buildEnv);
      this.phase("verify", "Verifying the new EXE's source provenance and SHA256...", 80);
      const dist = join(pkg, "dist");
      const hash = await verifyBugFlowArtifact(dist, commit);
      await exec(buildPython, ["-m", "pytest", join(pkg, "tests"), "-q", "--basetemp", join(pkg, "build", "pytest")],
        checkout, 10 * 60_000, { ...buildEnv, BUGFLOW_TEST_EXE: join(dist, "BugFlow.exe") });
      this.phase("install", "Copying the verified EXE into a new versioned user installation...", 90);
      deployed = join(root, "versions", `${commit.slice(0, 12)}-${attemptId}`);
      await mkdir(deployed, { recursive: true });
      for (const name of ["BugFlow.exe", "build-provenance.json", "BugFlow.exe.sha256"]) {
        await copyFile(join(dist, name), join(deployed, name));
      }
      await verifyBugFlowArtifact(deployed, commit);
      const cli = join(deployed, "BugFlow.exe");
      const version = await exec(cli, ["--version"], deployed, 60_000);
      if (!/^bugflow\b[^\r\n]*\d+\.\d+/i.test(version)) throw new Error("The installed EXE did not report a BugFlow version.");
      if (this.closing) throw new Error("Installation cancelled during shutdown.");
      await this.options.configure(instanceId, cli);
      configured = true;
      this.current = {
        ...this.current, state: "succeeded", phase: "done", progress: 100, cli, version, sha256: hash,
        message: "Fresh EXE installed. Host startup and authentication are separate; no host or login was started.",
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.current = {
        ...this.current, state: "failed",
        message: `${this.current.phase}: ${error instanceof Error ? error.message : String(error)} Previous installation settings were preserved.`,
        completedAt: new Date().toISOString(),
      };
    } finally {
      // Only remove exact directories created by this attempt, never versions
      // from an earlier installation (which may contain a running host).
      const cleanup: string[] = [];
      if (checkout) cleanup.push(checkout);
      if (deployed && !configured) cleanup.push(deployed);
      for (const path of cleanup) {
        try { await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
        catch { this.current.message += " Build cleanup was incomplete; unused build files remain in the managed directory."; }
      }
      if (lock) {
        try {
          await lock.close();
          await rm(lockPath, { force: true });
        } catch {
          this.current.message += " Could not remove the installation lock; remove it before another installation.";
        }
      }
      this.busy = false;
    }
  }
}
