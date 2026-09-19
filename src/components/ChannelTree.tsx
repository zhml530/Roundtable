import { ChevronDown, ChevronRight, Hash, Plus } from "lucide-react";
import type { Group } from "@/state/store";
import { channelEntries } from "@/lib/channel-topics";
import { cn } from "@/lib/cn";
import type { conversationMenuBindings } from "@/lib/conversation-menu";

export function ChannelTree({ groups, expanded, selectedId, onToggle, onOpen, onNewTopic, bindings }: {
  groups: Group[];
  expanded: Record<string, boolean>;
  selectedId: string;
  onToggle: (channelId: string, open: boolean) => void;
  onOpen: (topic: Group) => void;
  onNewTopic: (channelId: string) => void;
  bindings: (channelId: string) => ReturnType<typeof conversationMenuBindings>;
}) {
  return channelEntries(groups).map(({ channel, topics }) => {
    const channelId = channel.channelId ?? channel.id;
    const isOpen = expanded[channelId] ?? true;
    return (
      <div key={channelId} className="mb-1">
        <div className="group flex items-center rounded-lg hover:bg-raised" {...bindings(channelId)}>
          <button type="button" onClick={() => onToggle(channelId, !isOpen)} aria-expanded={isOpen}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-accent">
            <span className="text-ink-secondary">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
            <Hash size={16} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{channel.name}</span>
          </button>
          {!channel.dm && (
            <button type="button" onClick={() => onNewTopic(channelId)}
              aria-label={`New Topic in ${channel.name}`} title="New Topic"
              className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
              <Plus size={16} />
            </button>
          )}
        </div>
        {isOpen && (
          <div className="ml-7 border-l border-hairline/40 pl-2">
            {topics.map((topic) => (
              <button key={topic.id} type="button" {...bindings(topic.id)} onClick={() => onOpen(topic)}
                aria-current={selectedId === topic.id ? "page" : undefined}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] focus-visible:outline-2 focus-visible:outline-accent",
                  selectedId === topic.id ? "bg-accent/10 text-ink" : "text-ink-secondary hover:bg-raised hover:text-ink")}>
                <span className="min-w-0 flex-1 truncate">{topic.topicName ?? (topic.dm ? topic.name : "General")}</span>
                {topic.unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  });
}
