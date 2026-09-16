import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, type Bot, type Group } from "@/state/store";
import { setBotArchived } from "@/lib/bot-archive";
import { conversationMenuBindings, type ConversationMenuState, type ConversationMenuTarget } from "@/lib/conversation-menu";
import { ArchivedBotsPanel, BotContextMenu, RoomContextMenu, SectionPicker } from "./Sidebar";
import { NewTopicDialog } from "./NewTopicDialog";

export function useConversationMenus({ onTopicCreated }: { onTopicCreated?: (topic: Group) => void } = {}) {
  const { state, dispatch } = useStore();
  const stateRef = useRef(state);
  stateRef.current = state;
  const [menu, setMenu] = useState<ConversationMenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<ConversationMenuState | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string; restoreBot?: Bot } | null>(null);
  const [pending, setPending] = useState(false);
  const [newTopicChannelId, setNewTopicChannelId] = useState<string | null>(null);
  const newTopicChannel = state.groups.find((group) => group.id === newTopicChannelId);
  const archivedBots = state.bots.filter((bot) => bot.hidden);

  useEffect(() => {
    if (!feedback || feedback.error) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const setArchived = async (bot: Bot, hidden: boolean) => {
    setPending(true);
    setFeedback(null);
    try {
      await setBotArchived(bot.id, hidden, () => stateRef.current, dispatch);
      setFeedback({ error: false, text: `${bot.name} ${hidden ? "archived" : "restored"}`, restoreBot: hidden ? bot : undefined });
    } catch (cause) {
      setFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPending(false);
    }
  };

  const close = () => {
    setMenu(null);
    setSectionPicker(null);
  };
  const bindings = (target: ConversationMenuTarget) => conversationMenuBindings(target, (next) => {
    setSectionPicker(null);
    setMenu(next);
  });
  const menuKey = menu && ("groupId" in menu ? menu.groupId : `${menu.botId}:${menu.threadId ?? ""}`);
  const overlays = <>
    {newTopicChannel && <NewTopicDialog channel={newTopicChannel} onClose={() => setNewTopicChannelId(null)} onCreated={onTopicCreated} />}
    {menu && ("groupId" in menu ? (
      <RoomContextMenu key={menuKey} menu={menu} onClose={() => setMenu(null)}
        onNewTopic={setNewTopicChannelId}
        onMoveToSection={(groupId) => setSectionPicker({ ...menu, groupId })} />
    ) : createPortal(
      <BotContextMenu key={menuKey} menu={menu} threadId={menu.threadId} archivePending={pending} onClose={() => setMenu(null)}
        onArchive={(bot) => { void setArchived(bot, true); }}
        onMoveToSection={() => setSectionPicker(menu)} />,
      document.body,
    ))}
    {sectionPicker && createPortal(
      <SectionPicker anchor={sectionPicker}
        current={"groupId" in sectionPicker
          ? state.groups.find((group) => group.id === sectionPicker.groupId)?.section
          : state.bots.find((bot) => bot.id === sectionPicker.botId)?.section}
        onClose={() => setSectionPicker(null)}
        onAssign={(section) => {
          if ("groupId" in sectionPicker) dispatch({ type: "patchGroup", groupId: sectionPicker.groupId, patch: { section } });
          else dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } });
        }} />,
      document.body,
    )}
    {archivedOpen && <ArchivedBotsPanel bots={archivedBots} onClose={() => setArchivedOpen(false)}
      onRestored={(text) => setFeedback({ error: false, text })} />}
  </>;
  const footer = <>
    {archivedBots.length > 0 && (
      <button type="button" onClick={() => { close(); setArchivedOpen(true); }}
        className="mx-3 mb-2 rounded-lg px-2 py-2 text-left text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">
        Archived agents ({archivedBots.length})
      </button>
    )}
    {feedback && <div role={feedback.error ? "alert" : "status"}
      className={`mx-3 mb-2 rounded-lg px-2 py-2 text-[12px] ${feedback.error ? "text-danger" : "text-ink-secondary"}`}>
      {feedback.text}
      {feedback.restoreBot && <button type="button" disabled={pending}
        onClick={() => { if (feedback.restoreBot) void setArchived(feedback.restoreBot, false); }}
        className="ml-2 text-accent hover:underline disabled:opacity-40">Undo</button>}
    </div>}
  </>;
  const openNewTopic = (channelId: string) => { close(); setNewTopicChannelId(channelId); };
  return { bindings, close, overlays, footer, openNewTopic };
}
