interface ChannelHeaderSource {
  name: string;
  topicName?: string;
  dm?: boolean;
}

export function channelHeaderLabels(group: ChannelHeaderSource) {
  const topicName = group.topicName?.trim();
  return {
    title: topicName || group.name,
    subtitle: topicName ? group.name : group.dm ? "Direct message" : "Channel",
  };
}
