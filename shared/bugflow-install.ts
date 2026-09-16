export interface BugFlowInstallStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  phase: string;
  message: string;
  progress: number;
  instanceId?: string;
  attemptId?: string;
  commit?: string;
  cli?: string;
  version?: string;
  sha256?: string;
  startedAt?: string;
  completedAt?: string;
}
