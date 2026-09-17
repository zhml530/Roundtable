import { describe, expect, it } from "vitest";
import { Store } from "./store.ts";
import { deliverCoordinationMessage } from "./coordination-delivery.ts";
import type { CoordinationRun } from "./coordination.ts";

describe("Coordinator Channel delivery", () => {
  it("enriches the exact direct worker reply without duplicating it and remains idempotent after restart", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot({ name: "Atlas" });
    const channel = store.createGroup("Direct", [bot.id]);
    const session = store.ensureChannelSession(channel.id, bot.id)!;
    store.appendMessage(session.threadId, { role: "bot", kind: "text", text: "Hello" });
    const answer = store.appendMessage(session.threadId, { role: "bot", kind: "text", text: "Hello" });
    const run = {
      id: "delivery-run", executionMode: "direct", status: "completed", report: "Receipt",
      dispatch: { taskId: "direct", state: "conversation" },
      tasks: [{ id: "direct", botId: bot.id, botName: bot.name, threadId: session.threadId,
        replyMessageId: answer.id, title: "Greeting", description: "Say hello", role: "responder", status: "completed",
        dependsOn: [], attempt: 1, output: "Hello" }],
    } satisfies Pick<CoordinationRun, "id" | "executionMode" | "status" | "report" | "dispatch" | "tasks">;
    deliverCoordinationMessage(store, channel.id, "Hello", run);
    const messages = store.messagesFor(channel.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0].executionReport).toBeUndefined();
    expect(messages[1]).toMatchObject({ from: { botId: bot.id }, executionReport: "Receipt", coordinationRunId: run.id });
    expect(messages[1].author).toBeUndefined();
    const restored = new Store(() => ({ instanceId: "claude", model: "test" }));
    deliverCoordinationMessage(restored, channel.id, "Hello", run);
    expect(restored.messagesFor(channel.threadId)).toHaveLength(2);
  });

  it("deduplicates system-owned failed receipts without changing a partial worker reply", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot();
    const channel = store.createGroup("Failure", [bot.id]);
    const run = { id: "failed-delivery", executionMode: "direct", status: "failed", tasks: [], report: "Failed receipt" } as const;
    const delivery = { ...run, tasks: [] };
    deliverCoordinationMessage(store, channel.id, "No answer was produced.", delivery);
    deliverCoordinationMessage(store, channel.id, "No answer was produced.", delivery);
    expect(store.messagesFor(channel.threadId)).toMatchObject([{ author: "coordinator", coordinationRunId: run.id }]);
  });

  it("does not restore a redacted secret on direct completion or duplicate finalization", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot();
    const channel = store.createGroup("Redacted delivery", [bot.id]);
    const session = store.ensureChannelSession(channel.id, bot.id)!;
    const syntheticSecret = `ghp_${"A".repeat(36)}`;
    const raw = `A synthetic credential example: ${syntheticSecret}`;
    const answer = store.appendMessage(session.threadId, { role: "bot", kind: "text", text: raw });
    expect(answer.text).not.toContain(syntheticSecret);
    const run = {
      id: "redacted-run", executionMode: "direct", status: "completed", report: `Receipt ${raw}`,
      dispatch: { taskId: "direct", state: "conversation" },
      tasks: [{ id: "direct", botId: bot.id, botName: bot.name, threadId: session.threadId,
        replyMessageId: answer.id, title: "Reply", description: "Reply", role: "responder", status: "completed",
        dependsOn: [], attempt: 1, output: raw }],
    } satisfies Pick<CoordinationRun, "id" | "executionMode" | "status" | "report" | "dispatch" | "tasks">;
    deliverCoordinationMessage(store, channel.id, raw, run);
    deliverCoordinationMessage(store, channel.id, raw, run);
    expect(JSON.stringify(store.messagesFor(channel.threadId))).not.toContain(syntheticSecret);
  });

  it("keeps one worker answer when checkpoint failure is retried successfully", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "test" }));
    const bot = store.createBot();
    const channel = store.createGroup("Finalize retry", [bot.id]);
    const session = store.ensureChannelSession(channel.id, bot.id)!;
    const answer = store.appendMessage(session.threadId, { role: "bot", kind: "text", text: "Record appended." });
    const run = {
      id: "retry-delivery", executionMode: "direct" as const, status: "failed" as const, report: "Checkpoint failed",
      dispatch: { taskId: "direct", state: "project" as const },
      tasks: [{ id: "direct", botId: bot.id, botName: bot.name, threadId: session.threadId,
        replyMessageId: answer.id, title: "Append", description: "Append one record", role: "responder", status: "completed" as const,
        dependsOn: [], attempt: 1, output: "Record appended." }],
    };
    deliverCoordinationMessage(store, channel.id, "Record appended.\nRun failed: checkpoint unavailable", run);
    deliverCoordinationMessage(store, channel.id, "Record appended.", { ...run, status: "completed", report: "Completed" });
    const messages = store.messagesFor(channel.threadId);
    expect(messages.filter((message) => message.text?.includes("Record appended."))).toHaveLength(1);
    expect(messages.find((message) => message.from?.botId === bot.id)?.executionReport).toBe("Completed");
  });
});
