import type { Message } from "@/state/store";
import type { KeyedViewportItem } from "./message-viewport";

export interface ChannelViewportRow extends KeyedViewportItem {
  message: Message;
  showCluster: boolean;
  showDaySeparator: boolean;
}

/** Older persisted Coordinator deliveries predate the explicit author field. */
export function isCoordinatorMessage(message: Message | undefined): boolean {
  return message?.author === "coordinator" || Boolean(message?.executionReport);
}

/** Preserve sender/date boundaries even though each virtual row renders alone. */
export function channelViewportRows(messages: readonly Message[]): ChannelViewportRow[] {
  const visibleMessages = messages.filter((message) => message.kind !== "activity" || !message.source);
  return visibleMessages.map((message, index) => {
    const previous = visibleMessages[index - 1];
    const showDaySeparator = !previous
      || new Date(previous.at).toDateString() !== new Date(message.at).toDateString();
    const coordinator = isCoordinatorMessage(message);
    const showCluster = !previous
      || previous.role !== message.role
      || previous.from?.botId !== message.from?.botId
      || isCoordinatorMessage(previous) !== coordinator
      || showDaySeparator;
    return {
      key: message.id,
      messageIds: [message.id],
      message,
      showCluster,
      showDaySeparator,
    };
  });
}
