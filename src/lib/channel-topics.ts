import type { Dispatch } from "react";
import { api, type Action, type Group } from "@/state/store";

export function channelEntries(groups: Group[]): Array<{ channel: Group; topics: Group[] }> {
  const entries = new Map<string, { channel: Group; topics: Group[] }>();
  for (const group of groups) {
    const id = group.channelId ?? group.id;
    const entry = entries.get(id) ?? { channel: group, topics: [] };
    if (group.id === id) {
      entry.channel = group;
      entry.topics.unshift(group);
    } else entry.topics.push(group);
    entries.set(id, entry);
  }
  return [...entries.values()];
}

async function persistTopic(channelId: string, name: string): Promise<Group> {
  const response = await api(`/api/groups/${channelId}/topics`, {
    method: "POST", body: JSON.stringify({ name }),
  });
  return response.group;
}

export async function createChannelTopic(
  channelId: string,
  name: string,
  dispatch: Dispatch<Action>,
  persist: (channelId: string, name: string) => Promise<Group> = persistTopic,
): Promise<Group> {
  const group = await persist(channelId, name.trim());
  dispatch({ type: "groupPatched", group });
  dispatch({ type: "select", id: group.id });
  return group;
}
