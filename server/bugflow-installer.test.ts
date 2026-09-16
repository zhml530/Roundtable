import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUGFLOW_SOURCE_REF, BugFlowInstaller, installerEnvironment, runInstallCommand, type InstallCommand, type InstallRunner } from "./bugflow-installer.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const COMMIT = "a".repeat(40);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

async function fixture(failure?: "build" | "hash" | "provenance" | "configure" | "version" | "source") {
  const root = await mkdtemp(join(tmpdir(), "bugflow-install-test-"));
  roots.push(root);
  const old = join(root, "versions", "old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "BugFlow.exe"), "old host - never replace");
  const calls: InstallCommand[] = [];
  const configured: string[] = [];
  const run: InstallRunner = async (command) => {
    calls.push(command);
    if (command.args.includes("-3.12")) return "C:\\Python312\\python.exe";
    if (command.args.includes("fetch") && failure === "source") throw new Error("Source authorization required; finish login yourself.");
    if (command.args.includes("rev-parse")) return COMMIT;
    if (command.args.includes("-File")) {
      if (failure === "build") throw new Error("Fresh build failed");
      const dist = join(command.cwd, "BugFlow", "windows-agent", "dist");
      await mkdir(dist, { recursive: true });
      const exe = Buffer.alloc(1024 * 1024, 42);
      const hash = createHash("sha256").update(exe).digest("hex");
      await writeFile(join(dist, "BugFlow.exe"), exe);
      await writeFile(join(dist, "BugFlow.exe.sha256"), `${hash}  BugFlow.exe`);
      await writeFile(join(dist, "build-provenance.json"), JSON.stringify({
        schema_version: 1, requested_ref: BUGFLOW_SOURCE_REF,
        source: { kind: "clean-checkout", commit_identifies_source: true, base_commit: failure === "provenance" ? "b".repeat(40) : COMMIT },
        artifact: { name: "BugFlow.exe", size_bytes: exe.length, sha256: failure === "hash" ? "0".repeat(64) : hash },
      }));
    }
    if (command.program.endsWith("BugFlow.exe") && command.args[0] === "--version") {
      return failure === "version" ? "not the agent" : "BugFlow Agent 0.1.0";
    }
    return "";
  };
  const options = {
    root, platform: "win32" as const, run,
    configure: async (_id: string, cli: string) => {
      if (failure === "configure") throw new Error("Config save failed");
      configured.push(cli);
    },
  };
  return { root, old, calls, configured, options, installer: new BugFlowInstaller(options) };
}

describe("fresh-source standalone BugFlow installer", () => {
  it("resolves once per attempt, rebuilds/tests, verifies and configures a versioned EXE", async () => {
    const { installer, calls, root, configured, old } = await fixture();
    expect(installer.start("bugflow")).toMatchObject({ state: "running" });
    const result = await installer.wait();
    expect(result).toMatchObject({ state: "succeeded", commit: COMMIT, progress: 100 });
    expect(configured).toEqual([result.cli]);
    expect(result.cli).toContain(join(root, "versions"));
    expect(result.cli).toMatch(/BugFlow\.exe$/);
    expect(result.cli).not.toContain("venv");
    expect(calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
    expect(calls.find((c) => c.args.includes("fetch"))?.args).toContain(BUGFLOW_SOURCE_REF);
    expect(calls.find((c) => c.args.includes("-File"))?.args).toEqual(expect.arrayContaining([
      "-ExpectedCommit", COMMIT, "-SourceRef", BUGFLOW_SOURCE_REF, "-RequireCleanSource",
    ]));
    expect(calls.some((c) => c.args.includes("pytest"))).toBe(true);
    expect(calls.some((c) => c.args.some((arg) => ["serve", "login", "analyze"].includes(arg)))).toBe(false);
    expect(await readFile(join(old, "BugFlow.exe"), "utf8")).toBe("old host - never replace");
    expect(await readdir(join(root, "builds"))).toEqual([]);
    const firstCli = result.cli;
    installer.start("bugflow");
    const second = await installer.wait();
    expect(second.state).toBe("succeeded");
    expect(second.cli).not.toBe(firstCli);
    expect(calls.filter((c) => c.args.includes("fetch"))).toHaveLength(2);
    expect(calls.filter((c) => c.args.includes("-File"))).toHaveLength(2);
  });

  it.each(["build", "hash", "provenance", "configure", "version", "source"] as const)(
    "preserves the installed host and configuration after %s failure", async (failure) => {
      const { installer, configured, old, root } = await fixture(failure);
      installer.start("bugflow");
      expect(await installer.wait()).toMatchObject({ state: "failed" });
      expect(configured).toEqual([]);
      expect(await readFile(join(old, "BugFlow.exe"), "utf8")).toBe("old host - never replace");
      expect(await readdir(join(root, "versions"))).toEqual(["old"]);
    },
  );

  it("rejects concurrent jobs and non-Windows installation without spawning tools", async () => {
    const { installer, options, calls } = await fixture();
    expect(() => new BugFlowInstaller({ ...options, platform: "darwin" }).start("bugflow")).toThrow("Windows");
    expect(calls).toHaveLength(0);
    installer.start("bugflow");
    expect(() => installer.start("other")).toThrow("already running");
    await installer.wait();
  });

  it("does not steal another process's lock", async () => {
    const { installer, root, calls } = await fixture();
    await writeFile(join(root, "install.lock"), "other-process");
    installer.start("bugflow");
    expect(await installer.wait()).toMatchObject({ state: "failed", message: expect.stringContaining("install.lock") });
    expect(await readFile(join(root, "install.lock"), "utf8")).toBe("other-process");
    expect(calls).toHaveLength(0);
  });

  it("does not pass inherited provider keys to source/build/version commands", () => {
    const env = installerEnvironment();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("Never");
    expect(env.PIP_NO_INPUT).toBe("1");
    expect(env.PATHEXT).toBe(process.env.PATHEXT);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
  });

  it("bounds real command execution and never returns stderr secrets in errors", async () => {
    const command = { program: process.execPath, cwd: process.cwd(), env: installerEnvironment(), timeoutMs: 10_000 };
    await expect(runInstallCommand({ ...command, args: ["-e", "console.log('ok')"] })).resolves.toBe("ok");
    await expect(runInstallCommand({ ...command, args: ["-e", "console.error('private-output');process.exit(17)"] }))
      .rejects.toThrow("Command exited 17.");
    await expect(runInstallCommand({ ...command, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 200 }))
      .rejects.toThrow("timed out");
  });
});
