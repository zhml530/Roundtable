import type { CoordinationRun } from "./coordination.ts";
import type { Message, Store } from "./store.ts";
import { redactSecretsInText } from "./redact.ts";

type DeliveryRun = Pick<CoordinationRun, "id" | "executionMode" | "dispatch" | "status" | "tasks" | "report" | "error">;

export function deliverCoordinationMessage(store: Store, groupId: string, text: string, run?: DeliveryRun, artifacts?: Message["artifacts"]): void {
  const group = store.conversation(groupId);
  if (!group) throw new Error("The Channel conversation no longer exists");
  const messages = store.messagesFor(group.threadId);
  const delivery = { executionReport: run?.report ? redactSecretsInText(run.report) : undefined, artifacts, coordinationRunId: run?.id };
  if (run?.executionMode === "direct" && run.status === "completed") {
    const task = run.tasks.find((candidate) => candidate.id === run.dispatch?.taskId);
    const projected = task?.replyMessageId && messages.find((message) => message.source?.threadId === task.threadId
      && message.source?.messageId === task.replyMessageId && message.from?.botId === task.botId);
    if (!projected) throw new Error("The direct worker's final Channel message could not be found");
    store.patchMessage(group.threadId, projected.id, delivery);
    return;
  }
  const hasWorkerReply = run?.executionMode === "direct" && run.tasks.some((task) => task.replyMessageId);
  const notice = hasWorkerReply
    ? `Direct run ${run.status}.${run.error ? ` ${run.error}` : " See execution details."} The agent's response above is a partial result.`
    : text;
  const systemDelivery = { ...delivery, text: redactSecretsInText(notice) };
  const delivered = run && messages.find((message) => message.coordinationRunId === run.id && message.author === "coordinator");
  if (delivered) {
    store.patchMessage(group.threadId, delivered.id, systemDelivery);
    return;
  }
  store.appendMessage(group.threadId, { role: "bot", kind: "text", author: "coordinator", ...systemDelivery });
}
