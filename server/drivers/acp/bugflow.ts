import { z } from "zod";
import type { ProviderSnapshot } from "../../contracts.ts";
import { execCli, spawnCli } from "../../procs.ts";
import { createAcpDriver } from "./core.ts";

export const BUGFLOW_MODEL = "bugflow-default";
const statusSchema = z.object({
  state: z.enum(["ready", "auth_required", "unavailable"]),
  message: z.string().trim().min(1),
  version: z.string().trim().min(1),
});

/** A local, read-only host probe. Never starts the service or authenticates. */
export async function probeBugFlow(
  cli: string,
  environment: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ProviderSnapshot> {
  return new Promise((resolve) => {
    run(cli, ["status", "--json"], { timeout: 5_000, maxBuffer: 64 * 1024, env: environment }, (error, stdout) => {
      if (error) {
        resolve({
          state: "unavailable", authenticated: false,
          reason: `BugFlow status failed: ${error.message}. Check the configured CLI path and run \`bugflow-agent serve\` separately.`,
        });
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch {
        resolve({ state: "unavailable", authenticated: false, reason: "BugFlow status returned invalid JSON." });
        return;
      }
      const parsed = statusSchema.safeParse(value);
      if (!parsed.success) {
        resolve({ state: "unavailable", authenticated: false, reason: "BugFlow status returned an invalid readiness response." });
        return;
      }
      const status = parsed.data;
      resolve({
        state: status.state === "unavailable" ? "unavailable" : "available",
        authenticated: status.state === "ready",
        version: status.version,
        reason: status.message,
      });
    });
  });
}

export function createBugFlowAgentDriver(run: typeof execCli = execCli, spawnProcess: typeof spawnCli = spawnCli) {
  return createAcpDriver({
    driverKind: "bugflowAgent",
    displayName: "BugFlow Agent",
    defaultCli: "bugflow-agent",
    models: { default: BUGFLOW_MODEL, options: [{ id: BUGFLOW_MODEL, label: "BugFlow (agent-controlled)" }] },
    nativeSource: "bugflow.acp",
    spawnProcess,
    spawnArgs: () => ["acp"],
    // BugFlow owns its instructions; a persona prefix breaks its slash commands.
    buildPromptText: (turn) => turn.text,
    fixedModel: BUGFLOW_MODEL,
    strictResume: true,
    permissionPolicy: "explicit-once",
    localIntegrations: false,
    files: false,
    images: false,
    credentialEnv: [],
    transformEnv: (env) => {
      // The bridge connects to a separately governed host, never a BYOK model.
      for (const key of Object.keys(env)) {
        if (/^(COPILOT_|GH_|GITHUB_|OPENAI_|OPENROUTER_|ANTHROPIC_|AZURE_OPENAI_|KIMI_MODEL_|OLLAMA_|LMSTUDIO_|OMLX_|UNSLOTH_)/i.test(key)) {
          delete env[key];
        }
      }
    },
    probeSnapshot: (environment, config) => probeBugFlow(config.cli, environment, run),
    requireReadyBeforeSpawn: true,
    loginNote: "BugFlow requires setup. Check `bugflow-agent status --json` and complete any required login yourself.",
    pickAuthMethod: () => null,
    authFailure: "continue",
    isAuthenticated: async (env, config) => (await probeBugFlow(config.cli, env, run)).authenticated === true,
    classifyError: (error) => error instanceof Error && /auth_required|authentication required/i.test(error.message)
      ? "invalid_credentials" : undefined,
  });
}

export const BugFlowAgentDriver = createBugFlowAgentDriver();
