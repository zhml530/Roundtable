// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { existsSync, readFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR } from "./config.ts";
import * as mdb from "./message-db.ts";
import { workspaceDir } from "./workspace.ts";
import { newId, type CloudBackend, type ModelSelection, type ThreadId } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { redactSecretsInText } from "./redact.ts";
import { botAvatarProfile, type BotAvatarCrop } from "../shared/bot-avatar.ts";
import { agentColorForName, type AgentColor } from "../shared/agent-avatar.ts";
import type { ChangedFile } from "../shared/changed-files.ts";

export type { AgentColor } from "../shared/agent-avatar.ts";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission cards: the tool being requested, so the card can show what
   * is actually being asked and offer "always allow this tool". */
  tool?: string;
  /** why this stopped despite auto mode (destructive-looking command) */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
}

export interface ConnectorCardData {
  /** Composio toolkit slug. It is validated server-side before every action. */
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  /** Fixed allowlisted credential id; never an arbitrary config path. */
  target: import("../shared/credential-request.ts").CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  /** System-authored Channel delivery. Kept separate from Bot attribution. */
  author?: "coordinator";
  /** Origin of a Channel projection; approvals always resolve on this session. */
  source?: { threadId: string; messageId: string };
  executionReport?: string;
  coordinationRunId?: string;
  artifacts?: Array<{ label: string; path: string; threadId: string }>;
  changedFiles?: ChangedFile[];
  id: string;
  /** Provider turn that produced this runtime projection. Used by the
   * direct-chat UI to collapse tool activity without guessing boundaries. */
  turnId?: string;
  /** Runtime wall-clock timing, retained with the transcript. */
  turnStartedAt?: number;
  turnDurationMs?: number;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret";
  text?: string;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** activity messages: tool name + outcome. `spoken` is the same chip as
   * a phrase a voice can read ("reading a file") — computed once here so
   * call mode never has to re-derive it from the raw tool name, and absent
   * for chips not worth interrupting the ear for. */
  /** `setup` marks an error the user fixes by installing or configuring
   * something — the UI offers setup instead of a retry that cannot work. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean; itemId?: string };
  /** user messages sent INTO a running turn (capabilities.queueing): the
   * model saw it mid-turn, so the transcript marks it — a reader should
   * know the reply above it may already account for this line */
  steered?: boolean;
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Optional flat reply reference. Unlike parentId this never changes the
   * conversation branch; it only quotes one earlier text message inline. */
  replyToId?: string;
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string };
  /** comm chips: "Messaged @X" in the caller's chat, linking to the
   * bot⇄bot channel where the exchange is mirrored. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
  /** user messages sent while the bot was mid-turn, waiting in the
   * steer-queue to auto-send on settle. Cleared when the drain consumes
   * them; a true stranded by a restart is inert because the client only
   * shows the affordance while the bot is busy. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. The client pending
   * chip matches on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

/** A room: a shared thread where several bots + the user talk. User-created
 * channels are owned by the system Coordinator; `dm` rooms keep their private
 * peer/last-speaker routing. The bulletin is shared context for every task. */
export interface ChannelTopicRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  createdAt: number;
  unread: boolean;
  memberSessions?: Record<string, string>;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  busyBotId?: string | null;
}

export type GroupConversation = GroupRecord & { channelId?: string; topicName?: string };

export interface GroupRecord {
  /** Additional topics. The legacy root conversation backs General so old
   * transcript IDs, run receipts and checkpoint paths remain valid. */
  topics?: ChannelTopicRecord[];
  memberSessions?: Record<string, string>;
  id: string;
  threadId: ThreadId;
  name: string;
  memberIds: string[];
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** true for auto-created bot⇄bot channels (ask_bot exchanges live here;
   * the user can open the channel and chip in) */
  dm?: boolean;
  /** transient: the member currently running a turn (never persisted) */
  busyBotId?: string | null;
  /** the room's shared desk: where member turns run their shell tools,
   * overriding each member's own folder. The room pins its own copy on its
   * first turn (pinnedCwd). Absent = each member's own default. */
  cwd?: string;
  /** the folder this room's turns actually run in, pinned on the first
   * turn that dispatches. null = each member's own default; absent = not
   * pinned yet. See pinGroupCwd for why it never moves. */
  pinnedCwd?: string | null;
  /** the one message pinned to the top of this room's transcript. A pin id
   * that no longer resolves (edited away, deleted) simply renders nothing. */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under; shares the bots'
   * namespace so one heading can hold a project's room and its people */
  section?: string;
  /** New user-created rooms start with setup pending. Null timestamps are
   * intentional: records from before room setup has existed omit both keys
   * and remain immediately usable. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
}

/** One task = one conversation with its own context.
 *
 * A bot used to be a single endless thread, which meant every job
 * contaminated the next and the only way to get a clean slate was to
 * clone the bot. A task is that clean slate: its own thread, its own
 * transcript, and — the part that actually matters — its own provider
 * session. Sharing resume cursors between tasks would resume the other
 * task's session and quietly undo the whole thing. */
export type TaskCheckpointStatus = "active" | "blocked" | "completed";

/** Compact, user-maintained continuity context for one task. It is distinct
 * from the transcript (audit history) and from a Bot's reusable MEMORY.md. */
export interface TaskCheckpoint {
  summary: string;
  nextStep: string;
  status: TaskCheckpointStatus;
  updatedAt: number;
}

export interface TaskRecord {
  threadId: ThreadId;
  unread?: boolean;
  /** Manual reminders survive announcements while the chat is selected. */
  unreadSource?: "manual";
  title: string;
  /** Ownership of the current title. Missing on records created before
   * provenance was introduced; those records are never overwritten by an
   * asynchronous generated title. */
  titleSource?: "first-message" | "generated" | "user" | "assigned";
  /** Internal once-only claim for the best-effort first-turn generation. */
  titleGenerationAttemptedAt?: number;
  createdAt: number;
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current — another engine may have
   * taken turns since — so this is what decides an inline replay. Absent
   * on tasks from before the field existed. */
  lastInstanceId?: string;
  /** what this task has spent: banked once per turn from turn.completed */
  usage?: TaskUsage;
  /** the folder this task's turns run in, pinned on its first turn from
   * the bot's `cwd` at that moment. Pinned, not read live: Claude keeps
   * sessions per project directory and Codex threads carry their cwd, so
   * a folder that moved under a live session would break resume. `null`
   * = pinned to the default (home); absent = not pinned yet. */
  cwd?: string | null;
  /** A bounded checkpoint for resuming work after a task switch or restart. */
  checkpoint?: TaskCheckpoint;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** null until any turn reports a cost — most engines never do. Records
   * written by builds before cost existed lack the field; read as null. */
  costUsd: number | null;
  turns: number;
}

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line), a permission card's summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.tool?.name) out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

/** What changed, emitted by the store itself right after each write. The
 * server maps these onto its SSE frames in ONE place, so no mutation path
 * can persist without the app hearing about it — the two-write-paths bug
 * (persist without emit → UI drifts; emit without persist → a restart
 * loses what the user just watched) is closed by construction. Bot and
 * group changes carry only the id: the wire shape (cursor stripping) is
 * the caller's business. */
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };

/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

export interface BotRecord {
  id: string;
  /** Active chat's thread; empty when the agent has no active chat. */
  threadId: ThreadId;
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: AgentColor;
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** Initials, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  modelSelection: ModelSelection;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** which computer the bot acts on: its cloud box, this computer,
   * or none. Unset = auto (box when it exists, else local when available). */
  computer?: "cloud" | "vm" | "local" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Legacy persisted field, discarded during migration. */
  autoStartVps?: boolean;
  /** where NEW tasks run their shell tools; each task pins its own copy
   * on its first turn (TaskRecord.cwd). Absent = the home folder. */
  cwd?: string;
  /** Auto mode: the bot approves its own tool permissions and keeps
   * working instead of stopping to ask. Questions it asks YOU still come
   * through, and a short list of destructive commands still stops it. */
  autoApprove?: boolean;
  /** Tools this bot may always use without asking, even outside auto mode
   * (set by "Always allow" on an approval card). */
  alwaysAllow?: string[];
  /** Speak this bot's replies aloud as they settle, without being asked.
   * Off by default: a hosted voice costs money per character, so speaking
   * is something you turn on, never something that happens to you. */
  speakReplies?: boolean;
  /** This bot's own voice id, so a room of bots doesn't sound like one
   * person. Falls back to the app-wide voice in config. */
  voice?: string;
  /** true after an edit/branch-switch rewound the visible conversation:
   * provider sessions still hold the abandoned branch, so the next turn
   * must start fresh (drop cursors) and replay the surviving path. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread; a pin
   * that no longer resolves (branch switched away, deleted) renders nothing */
  pinnedMessageId?: string;
  /** Pause for human approval before this bot talks to a peer (ask_bot,
   * delegate_bot). Off by default so peer collaboration can run without
   * interrupting after every handoff. */
  approvePeerComms?: boolean;
  /** Whether this bot may use the workspace's connected apps (Composio).
   * Unset/true = allowed (the user configured the key deliberately);
   * false = this bot never receives the connection. Imported team members
   * start false — a shared persona must not reach the user's Gmail on
   * turn one. */
  composio?: boolean;
  /** Public, package-authored playbooks installed for this bot. They carry
   * process guidance only—never executable code, credentials, or grants. */
  playbooks?: InstalledPlaybook[];
  /** Listing provenance and connector intent retained for package details
   * and future re-export. It never means the apps are authorized. */
  installedPackage?: InstalledPackageMetadata;
  /** Derived from `activity` — kept so the 200+ readers across the app and
   * tests keep working unchanged. Write through setActivity(), never here. */
  busy?: boolean;
  /** What the bot is doing right now, as the harness sees it. `busy` alone
   * could not tell working from waiting-on-you from a stalled engine.
   * Transient like busy: reset to idle on load. */
  activity?: BotActivity;
  createdAt: number;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

/** Sections are persisted as display labels, so exact trimmed labels are
 * their identity. Missing/blank means the unsectioned (General) team. */
export const sectionKey = (section?: string | null): string => section?.trim() || "";

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, the name must end on a word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length]; // must not run into a longer word
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Resolve explicit targets for internal bot-to-bot rooms. Ordinary user
 * channels never call this: their messages are Coordinator goals. */
export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
): T[] {
  const available = members.filter((member) => !member.hidden);
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  return [];
}

const onboardingCard = (): OptionCardData => ({
  title: "What do you mostly want help with?",
  subtitle: "Pick whatever's closest; we can always expand from there.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});

/** Messages form a tree (forks appear when a message is edited); the
 * visible conversation is the path from the root to activeLeafId. */
interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads = new Map<string, ThreadState>();
  private defaultSelection: () => ModelSelection;
  private listeners = new Set<(change: StoreChange) => void>();

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
      this.bots = [];
    }
    try {
      this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
    } catch {
      this.groups = [];
    }
    // busy never survives a restart — no turn does either. Rooms saved
    // before default responders existed adopt their first member as lead.
    let botsMigrated = false;
    let groupsMigrated = false;
    for (const b of this.bots) {
      // transient state never survives a restart — and if a previous
      // process died mid-turn, bots.json still says busy/working; persist
      // the reset so the next load does not read it again
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      b.busy = false;
      b.activity = "idle";
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (b.autoStartVps !== undefined) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      // SAFETY: persisted JSON can contain fields from a pre-release schema;
      // this temporary dictionary view is used only to delete one retired key.
      const stale = b as BotRecord & Record<string, unknown>;
      const retiredLeadershipField = ["chief", "Of", "Staff"].join("");
      if (retiredLeadershipField in stale) {
        delete stale[retiredLeadershipField];
        botsMigrated = true;
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
      if ("mascotExpression" in stale) {
        delete stale.mascotExpression;
        botsMigrated = true;
      }
    }
    // Peer grants originally used mutable display names (ask_bot:@Helper).
    // Convert only when exactly one bot has that name; ambiguous legacy
    // entries remain inert rather than granting access to the wrong bot.
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    for (const g of this.groups) {
      g.busyBotId = null;
      for (const topic of g.topics ?? []) topic.busyBotId = null;
      // The Coordinator model deliberately drops the legacy channel routing
      // field. It disappears from disk on the next normal store write.
      if (Object.prototype.hasOwnProperty.call(g, "defaultResponder")) {
        delete (g as GroupRecord & { defaultResponder?: unknown }).defaultResponder;
        groupsMigrated = true;
      }
    }
    if (botsMigrated) this.saveBots();
    if (groupsMigrated) this.saveGroups();
    // bots saved before tasks existed have one endless thread; adopt it as
    // their first task so nothing is lost and nothing special-cases it
    for (const b of this.bots) {
      if (b.tasks) continue;
      b.tasks = [
        {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        },
      ];
    }
    // Adopt the legacy active-chat badge; inactive chats had no unread state.
    for (const bot of this.bots) {
      for (const task of bot.tasks ?? []) {
        task.unread ??= task.threadId === bot.threadId && bot.unread;
      }
    }
    // Search reads SQLite directly, so migrate every known legacy transcript
    // at startup rather than waiting until the user happens to open it. Only
    // pending JSON files are touched; already-migrated threads stay lazy.
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => (b.tasks ?? []).map((task) => task.threadId)),
      ...this.conversations().map((group) => group.threadId),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
    }
    // Provider requests cannot survive a process restart. Preserve the session
    // cursors, but retire its stale cards in both the session and the Channel.
    for (const group of this.conversations()) {
      for (const threadId of Object.values(group.memberSessions ?? {})) {
        for (const message of this.messagesFor(threadId)) {
          if (message.card?.requestId && !message.card.answered && !message.card.dismissed) {
            this.patchMessage(threadId, message.id, { card: { ...message.card, answered: "unavailable", dismissed: true } });
          }
        }
      }
    }
  }

  private saveBots() {
    writeFileAtomic(BOTS_FILE, JSON.stringify(this.bots, null, 2));
  }

  private saveGroups() {
    writeFileAtomic(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId: _busy, topics, ...g }) => ({
      ...g,
      topics: topics?.map(({ busyBotId: _topicBusy, ...topic }) => topic),
    })), null, 2));
  }

  // ── groups ────────────────────────────────────────────────────────────
  /** Subscribe to every write. Listeners run after the write and after
   * save; a throwing listener never breaks the write. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange) {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  private conversationRecord(id: string): { channel: GroupRecord; record: GroupRecord | ChannelTopicRecord } | undefined {
    for (const channel of this.groups) {
      if (channel.id === id) return { channel, record: channel };
      const topic = channel.topics?.find((candidate) => candidate.id === id);
      if (topic && !channel.dm) return { channel, record: topic };
    }
  }

  conversation(id: string): GroupConversation | undefined {
    const owner = this.conversationRecord(id);
    if (!owner) return undefined;
    const { channel, record } = owner;
    const { topics: _topics, ...settings } = channel;
    const conversation: GroupConversation = {
      ...settings,
      id: record.id,
      threadId: record.threadId,
      createdAt: record.createdAt,
      unread: record.unread,
      memberSessions: record.memberSessions,
      pinnedCwd: record.pinnedCwd === undefined ? channel.pinnedCwd : record.pinnedCwd,
      pinnedMessageId: record.pinnedMessageId,
      busyBotId: record.busyBotId,
    };
    if (!channel.dm) {
      conversation.channelId = channel.id;
      conversation.topicName = record === channel ? "General" : record.name;
    }
    return conversation;
  }

  conversations(channelId?: string): GroupConversation[] {
    return this.groups.filter((group) => !channelId || group.id === channelId)
      .flatMap((group) => [group.id, ...(group.dm ? [] : (group.topics ?? []).map((topic) => topic.id))])
      .map((id) => this.conversation(id)!);
  }

  createTopic(channelId: string, rawName: string): GroupConversation {
    const channel = this.group(channelId);
    if (!channel) throw Object.assign(new Error("no such channel"), { status: 404 });
    if (channel.dm) throw Object.assign(new Error("direct-message channels cannot have topics"), { status: 400 });
    if (!rawName.trim() || rawName.trim().length > 100) {
      throw Object.assign(new Error("topic name must contain 1 to 100 characters"), { status: 400 });
    }
    const topic: ChannelTopicRecord = {
      id: newId(), threadId: newId(), name: rawName.trim(), createdAt: Date.now(), unread: false,
    };
    const previous = channel.topics;
    channel.topics = [...(previous ?? []), topic];
    try {
      this.saveGroups();
    } catch (error) {
      channel.topics = previous;
      throw error;
    }
    this.emit({ type: "group", groupId: topic.id });
    return this.conversation(topic.id)!;
  }

  patchConversation(id: string, patch: Partial<Pick<ChannelTopicRecord, "unread" | "busyBotId" | "pinnedMessageId" | "pinnedCwd" | "memberSessions">> & { topicName?: string }): GroupConversation | null {
    const owner = this.conversationRecord(id);
    if (!owner) return null;
    const { topicName, ...local } = patch;
    if (topicName !== undefined) {
      if (owner.record === owner.channel) throw new Error("General uses the channel name");
      const name = topicName.trim();
      if (!name || name.length > 100) throw new Error("topic name must be between 1 and 100 characters");
      owner.record.name = name;
    }
    Object.assign(owner.record, local);
    this.saveGroups();
    this.emit({ type: "group", groupId: id });
    return this.conversation(id)!;
  }

  groupByThread(threadId: string): GroupConversation | undefined {
    return this.conversations().find((g) => g.threadId === threadId);
  }

  channelSession(threadId: string): { group: GroupRecord; bot: BotRecord } | undefined {
    for (const group of this.conversations()) {
      if (group.dm) continue;
      const botId = Object.keys(group.memberSessions ?? {}).find((id) => group.memberSessions![id] === threadId && group.memberIds.includes(id));
      const bot = botId ? this.bot(botId) : null;
      if (bot && this.taskByThread(bot.id, threadId)) return { group, bot };
    }
  }

  /** Reuse one provider conversation per Topic/Bot, never the direct chat. */
  ensureChannelSession(groupId: string, botId: string, adoptThreadId?: string): TaskRecord | null {
    const group = this.conversation(groupId);
    if (!group || group.dm || !group.memberIds.includes(botId)) return null;
    const existing = group.memberSessions?.[botId];
    const task = existing ? this.taskByThread(botId, existing) : undefined;
    if (task) return task;
    const adoptable = adoptThreadId && !this.conversations().some((other) => Object.values(other.memberSessions ?? {}).includes(adoptThreadId))
      ? this.taskByThread(botId, adoptThreadId) : undefined;
    const created = adoptable ?? this.createTask(botId, `Channel: ${group.name}`, false);
    if (!created) return null;
    group.pinnedCwd ??= this.pinGroupCwd(group.channelId ?? group.id);
    if (group.pinnedCwd && created.cwd === undefined && !Object.keys(created.resumeCursors).length) {
      created.cwd = group.pinnedCwd;
      this.saveBots();
    }
    this.patchConversation(groupId, {
      pinnedCwd: group.pinnedCwd,
      memberSessions: { ...group.memberSessions, [botId]: created.threadId },
    });
    return created;
  }

  private projectChannelMessage(threadId: string, message: Message): void {
    const session = this.channelSession(threadId);
    if (!session || message.role !== "bot" || message.kind === "activity" || message.source) return;
    const { group, bot } = session;
    const existing = this.messagesFor(group.threadId).find((m) => m.source?.threadId === threadId && m.source.messageId === message.id);
    const { id, parentId: _parent, ...body } = message;
    const projected = { ...body, from: { botId: bot.id, name: bot.name, color: bot.color }, source: { threadId, messageId: id } };
    if (existing) this.patchMessage(group.threadId, existing.id, projected);
    else this.appendMessage(group.threadId, projected);
  }

  createGroup(name: string, memberIds: string[], dm = false, section?: string): GroupRecord {
    const group: GroupRecord = {
      id: newId(),
      threadId: newId(),
      name,
      memberIds,
      bulletin: "",
      unread: false,
      createdAt: Date.now(),
      dm: dm || undefined,
      busyBotId: null,
      section,
      ...(dm ? {} : { setupCompletedAt: null, setupSkippedAt: null }),
    };
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "bulletin" | "unread" | "busyBotId" | "cwd" | "section" | "setupCompletedAt" | "setupSkippedAt">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    Object.assign(group, patch);
    if (patch.memberIds && group.memberSessions) {
      group.memberSessions = Object.fromEntries(Object.entries(group.memberSessions).filter(([botId]) => group.memberIds.includes(botId)));
    }
    if (patch.memberIds) {
      for (const topic of group.topics ?? []) {
        if (topic.memberSessions) topic.memberSessions = Object.fromEntries(
          Object.entries(topic.memberSessions).filter(([botId]) => group.memberIds.includes(botId)),
        );
      }
    }
    this.saveGroups();
    for (const conversation of this.conversations(group.id)) this.emit({ type: "group", groupId: conversation.id });
    return group;
  }

  /** A thread's durable record: DB rows plus any legacy JSON leftovers. */
  private deleteThreadRecord(threadId: string) {
    this.threads.delete(threadId);
    mdb.deleteThread(threadId);
    for (const file of [messagesFile(threadId), `${messagesFile(threadId)}.imported`]) {
      try {
        unlinkSync(file);
      } catch {}
    }
  }

  deleteConversation(id: string): boolean {
    const owner = this.conversationRecord(id);
    if (!owner) return false;
    if (owner.record === owner.channel) return this.deleteGroup(id);
    owner.channel.topics = owner.channel.topics?.filter((topic) => topic.id !== id);
    this.saveGroups();
    this.deleteThreadRecord(owner.record.threadId);
    this.emit({ type: "group.deleted", groupId: id });
    return true;
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.saveGroups();
    this.deleteThreadRecord(group.threadId);
    this.emit({ type: "group.deleted", groupId: id });
    for (const topic of group.topics ?? []) {
      this.deleteThreadRecord(topic.threadId);
      this.emit({ type: "group.deleted", groupId: topic.id });
    }
    return true;
  }

  private thread(threadId: string): ThreadState {
    let t = this.threads.get(threadId);
    if (t) return t;
    // SQLite is the source of truth; a thread with no rows imports its
    // legacy messages-<threadId>.json once, inside readThread
    const { messages, activeLeafId: storedLeaf } = mdb.readThread(threadId, messagesFile(threadId));
    let activeLeafId = storedLeaf;
    // legacy rows carry no parentId — chain them in array order
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
    t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  messagesFor(threadId: string): Message[] {
    if (!threadId) return [];
    return this.thread(threadId).messages;
  }

  activeLeaf(threadId: string): string | null {
    if (!threadId) return null;
    return this.thread(threadId).activeLeafId;
  }

  /** The visible conversation: root → activeLeafId. */
  activePath(threadId: string): Message[] {
    if (!threadId) return [];
    const t = this.thread(threadId);
    const byId = new Map(t.messages.map((m) => [m.id, m]));
    const path: Message[] = [];
    let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    if (!threadId) throw new Error("Create a chat before adding messages");
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    t.messages.push(full);
    t.activeLeafId = full.id;
    mdb.appendMessage(threadId, full);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.emit({ type: "message", threadId, message: full });
    this.projectChannelMessage(threadId, full);
    // The first-run quiz is not a live ask. Talking past it hides it so the
    // transcript is just the greeting plus what they said. Cards with a
    // requestId are permission/question prompts and stay until answered.
    if (full.role === "user" && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  /** Hide the first-run quiz on this thread, if it is still open. */
  dismissOnboardingCard(threadId: string): Message | null {
    const t = this.thread(threadId);
    const card = t.messages.find(
      (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
    );
    if (!card?.card) return null;
    return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  /** Screen frames are ~100-500KB of base64 each; keeping every frame of a
   * long computer session bloats the transcript for nothing the client
   * would ever show. The newest few keep their pixels; older ones stay in
   * the transcript as placeholders. Mirrors the client's own frame cap.
   * Returns the messages whose pixels were dropped so the caller can
   * persist exactly those. */
  private pruneScreenFrames(t: { messages: Message[] }, keep = 4): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png) continue;
      seen += 1;
      if (seen > keep) {
        m.png = undefined;
        pruned.push(m);
      }
    }
    return pruned;
  }

  /** Fork the conversation: a new user message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf. */
  branchMessage(threadId: string, sourceId: string, text: string): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: "user",
      kind: "text",
      text,
      parentId: source.parentId ?? null,
      replyToId: source.replyToId,
    };
    t.messages.push(full);
    t.activeLeafId = full.id;
    mdb.appendMessage(threadId, full);
    this.emit({ type: "message", threadId, message: full });
    return full;
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    t.activeLeafId = cur;
    mdb.setActiveLeaf(threadId, cur);
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    t.messages[idx] = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    mdb.updateMessage(threadId, t.messages[idx]);
    this.emit({ type: "message.patch", threadId, message: t.messages[idx] });
    this.projectChannelMessage(threadId, t.messages[idx]);
    return t.messages[idx];
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.tasks?.some((t) => t.threadId === threadId)) ?? null;
  }

  createBot(
    profile: Partial<
      Pick<BotRecord, "name" | "title" | "description" | "color" | "modelSelection" | "section">
    > = {},
    opts: {
      /** false = no greeting/onboarding seed. Imported bots must not open
       * with a first-person greeting the user never asked for. */
      seedMessages?: boolean;
    } = {},
  ): BotRecord {
    const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
    const section = sectionKey(profile.section);
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      notifications: true,
      color: profile.color ?? agentColorForName(name),
      unread: false,
      modelSelection: profile.modelSelection ?? this.defaultSelection(),
      resumeCursors: {},
      createdAt: Date.now(),
    };
    if (section) bot.section = section;
    bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {} }];
    this.bots.unshift(bot);
    this.saveBots();
    // Announce the owner before its onboarding transcript. SSE clients need
    // the bot/thread mapping before they can place either message.
    this.emit({ type: "bot", botId: bot.id });
    if (opts.seedMessages !== false) {
      this.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `Hey — I'm ${name}. Nice to meet you.`,
      });
      this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    }
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    // every task's transcript goes with the bot, not just the open one
    for (const threadId of new Set((bot.tasks ?? []).map((t) => t.threadId))) {
      this.deleteThreadRecord(threadId);
    }
    // the bot's workspace (files + memory) goes with it — same rule as its
    // transcripts: deleting a bot deletes what it knew
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
    } catch {}
    this.saveBots();
    this.emit({ type: "bot.deleted", botId: id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    if (patch.unread !== undefined) {
      const task = this.activeTask(id);
      if (task) {
        task.unread = patch.unread;
        delete task.unreadSource;
      }
    }
    this.saveBots();
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  /** The one way runtime state changes. Sets `activity` and derives `busy`
   * from it, so a reader that only knows busy sees the same truth. */
  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const busy = ACTIVITY_BUSY.has(activity);
    if (bot.activity === activity && Boolean(bot.busy) === busy) return bot;
    bot.activity = activity;
    bot.busy = busy;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    // the cursor belongs to the task that produced it, not to the bot
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (task) task.resumeCursors[instanceId] = cursor;
    // The legacy mirror follows the task visible in chat, never a detached
    // routine task working in the background.
    if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Record which instance just took a turn on this task. Called at
   * dispatch, not at cursor time — transcript-replay engines never
   * produce a cursor, and they still count as having run last. */
  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
    this.saveBots();
  }

  /** Bank one settled turn onto its task. Called once per turn.completed;
   * the running per-driver token indicator is deliberately not used here
   * because its meaning differs by driver. */
  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; costUsd: number | null },
  ): TaskUsage | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
    const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
    // providers occasionally report NaN or a negative on a partial turn —
    // never let that poison a running tally
    const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    task.usage = {
      input: prev.input + clean(turn.input),
      output: prev.output + clean(turn.output),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
    };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  /** The folder a task's turn runs in. Pins on first call from the bot's
   * current folder — unless the task already has a session (a thread from
   * before folders existed), which pins to the default so the folder can't
   * move under it. Returns the pinned value: a path, or null for default. */
  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.none) {
      if (task.cwd !== null) {
        task.cwd = null;
        this.saveBots();
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd === undefined) {
      task.cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
      this.saveBots();
      this.emit({ type: "bot", botId });
    }
    return task.cwd;
  }

  /** The folder a room's member turns run in. Pins on the first turn that
   * dispatches, from the room's `cwd` at that moment. Pinned, not read
   * live, for the same reason tasks pin (see pinTaskCwd): engines key
   * their sessions and files to the folder a thread starts in, and a room
   * lives on ONE thread forever — so changing the room's folder applies to
   * future rooms, never under a room that already started working
   * somewhere. Returns the pinned value: a path, or null = each member's
   * own default. */
  pinGroupCwd(groupId: string): string | null {
    const group = this.group(groupId);
    if (!group) return null;
    if (group.pinnedCwd === undefined) {
      group.pinnedCwd = group.cwd ?? null;
      this.saveGroups();
      for (const conversation of this.conversations(group.id)) this.emit({ type: "group", groupId: conversation.id });
    }
    return group.pinnedCwd;
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  /** The first thing the human asked in a thread — a task's natural name. */
  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  /** Only explicit conversation entry points create a chat, never loading an agent. */
  ensureActiveTask(botId: string): TaskRecord | null {
    return this.activeTask(botId) ?? this.createTask(botId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
  }

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Becomes the active task. */
  createTask(botId: string, title?: string, activate = true): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const task: TaskRecord = {
      threadId: newId(),
      title: title?.trim() || UNTITLED_TASK,
      createdAt: Date.now(),
      resumeCursors: {},
    };
    if (title?.trim()) task.titleSource = "assigned";
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      bot.threadId = task.threadId;
      bot.resumeCursors = {}; // legacy mirror follows the active task
      bot.unread = false;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    bot.threadId = task.threadId;
    bot.resumeCursors = { ...task.resumeCursors };
    task.unread = false;
    delete task.unreadSource;
    bot.unread = false;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  setTaskUnread(botId: string, threadId: string, unread: boolean): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    task.unread = unread;
    if (unread) task.unreadSource = "manual";
    else delete task.unreadSource;
    // Compatibility for agent-level badges/actions; tasks own the persisted truth.
    if (bot.threadId === threadId) bot.unread = unread;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    const task = this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    task.titleSource = "user";
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  updateTaskCheckpoint(
    botId: string,
    threadId: string,
    checkpoint: Pick<TaskCheckpoint, "summary" | "nextStep" | "status">,
  ): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    const summary = checkpoint.summary.trim().slice(0, 2_000);
    const nextStep = checkpoint.nextStep.trim().slice(0, 800);
    if (!summary && !nextStep) delete task.checkpoint;
    else task.checkpoint = { summary, nextStep, status: checkpoint.status, updatedAt: Date.now() };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Name a task after its first message, once. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string) {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    task.titleSource = "first-message";
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Replace only the deterministic first-message fallback. A user rename or
   * assigned system title always wins, including when it races this update. */
  claimTaskTitleGeneration(botId: string, threadId: string): boolean {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.titleSource !== "first-message" || task.titleGenerationAttemptedAt) return false;
    task.titleGenerationAttemptedAt = Date.now();
    this.saveBots();
    return true;
  }

  setGeneratedTaskTitle(botId: string, threadId: string, title: string): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.titleSource !== "first-message") return null;
    const clean = title.trim().slice(0, 80);
    if (!clean) return null;
    task.title = clean;
    task.titleSource = "generated";
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Delete a chat without deleting its agent. Empty threadId means no active chat. */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !bot.tasks) return null;
    if (!bot.tasks.some((t) => t.threadId === threadId)) return null;
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (bot.threadId === threadId) {
      const next = bot.tasks[0];
      bot.threadId = next?.threadId ?? "";
      bot.resumeCursors = { ...next?.resumeCursors };
      bot.unread = next?.unread ?? false;
      delete bot.pinnedMessageId;
      delete bot.rewound;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** First-run seed: one bot so the app never opens empty — it gets a
   * random friendly name like every other bot. */
  seedIfEmpty() {
    if (this.bots.length) return;
    this.createBot();
  }
}
