import { Users } from "lucide-react";
import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import type { Bot } from "@/state/store";

type ChannelMember = BotAvatarProps["bot"] & Pick<Bot, "id" | "mascotExpression">;

export function ChannelAvatar({
  members,
  size = 32,
  busyBotId,
}: {
  members: readonly ChannelMember[];
  size?: number;
  busyBotId?: string | null;
}) {
  const shown = members.slice(0, 3);
  const working = members.find((member) => member.id === busyBotId);
  const label = `${members.length} ${members.length === 1 ? "bot" : "bots"}${members.length ? `: ${members.map((member) => member.name ?? "Bot").join(", ")}` : ""}${working ? `; ${working.name ?? "Bot"} is working` : ""}`;
  const areas = shown.length === 1
    ? ["1 / 1 / 3 / 3"]
    : shown.length === 2
      ? ["1 / 1 / 3 / 2", "1 / 2 / 3 / 3"]
      : ["1 / 1 / 3 / 2", "1 / 2 / 2 / 3", "2 / 2 / 3 / 3"];

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative inline-grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-full bg-raised"
      style={{ width: size, height: size }}
    >
      {shown.length === 0 ? (
        <span aria-hidden="true" className="col-span-2 row-span-2 flex items-center justify-center text-ink-secondary">
          <Users size={size * 0.6} />
        </span>
      ) : shown.map((member, index) => (
        <span
          key={member.id}
          aria-hidden="true"
          className="relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-raised"
          style={{ gridArea: areas[index] }}
        >
          <BotAvatar
            bot={member}
            size={shown.length === 3 && index > 0 ? size / 2 : size}
            state={normalizeState(member.mascotExpression) ?? "happy"}
            imageShape="square"
            animated={false}
            trackPointer={false}
          />
          {member.id === busyBotId && (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full border border-app bg-accent" />
          )}
        </span>
      ))}
      {shown.length > 1 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-panel" />
      )}
      {shown.length === 3 && (
        <span aria-hidden="true" className="pointer-events-none absolute left-1/2 right-0 top-1/2 h-px -translate-y-1/2 bg-panel" />
      )}
    </span>
  );
}
