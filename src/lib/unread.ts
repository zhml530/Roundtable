export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean; threadId?: string; tasks?: Array<{ threadId: string; unread?: boolean }> }>,
  groups: Array<{ unread?: boolean }>,
): number {
  return bots.reduce((count, bot) => {
    if (bot.hidden) return count;
    if (!bot.tasks?.length) return count + Number(!!bot.unread);
    return count + bot.tasks.filter((task) =>
      task.unread ?? (task.threadId === bot.threadId && bot.unread),
    ).length;
  }, 0) + groups.filter((group) => group.unread).length;
}
