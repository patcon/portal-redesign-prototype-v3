/**
 * The seam between the agent's wire shapes and the design system's prop shapes.
 *
 * Everything here is a pure function over plain data, and that is the point: the
 * components under `ui/` and `dembrane/` are copied from `dembrane-portal-redesign`
 * and are overwritten wholesale by the next copy, so nothing that knows about
 * `useAgentChat`, `ChatMeta` or this app's conventions may live inside them. When
 * the design repo moves, only this file has to be reconciled.
 */

import type { ChatMessageData, ChatUser } from "@/components/ui/chatcn/types";
import type { ActivityMessageData } from "@/components/dembrane/Activity";
import type { ConversationMessage } from "@/components/dembrane/ConversationMessages";
import type { PlatformMessageData } from "@/components/dembrane/PlatformMessage";
import type { ChatEntry, ConversationState, RecordingMeta } from "../types";

/**
 * The shape this file reads out of `useAgentChat`, written structurally rather than
 * imported. `UIMessage` is a deep generic over the whole AI SDK, and none of that
 * generality reaches here — a role, some text parts and an optional metadata tag is
 * the entire contract.
 */
export type AgentMessage = {
  id: string;
  role: string;
  parts: Array<{ type: string; text?: string }>;
  metadata?: unknown;
};

/** Dembrane speaking as itself, rather than any participant at the conversation. */
export const DEMBRANE: ChatUser = { id: "dembrane", name: "Dembrane" };

/** The prefix the server puts on a call transcript before leaving it in the thread. */
const TRANSCRIPT_PREFIX = /^Voice call transcript:\n/;

/** Text of a message, with the non-text parts (tool calls, reasoning) dropped. */
function textOf(message: AgentMessage): string {
  return message.parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function isVoiceCall(message: AgentMessage): boolean {
  return kindOf(message) === "voice-call";
}

function kindOf(message: AgentMessage): string | undefined {
  return (message.metadata as { kind?: string } | undefined)?.kind;
}

/** The recording a call message points at, if it has one. */
function recordingIdOf(message: AgentMessage): string | null {
  return (message.metadata as { recordingId?: string } | undefined)?.recordingId ?? null;
}

/**
 * Every recording the thread refers to, in the order the calls happened.
 *
 * The pane fetches each one's metadata; a call in progress is re-read as it
 * runs, which is what makes a live voice note grow. Both messages a call leaves
 * behind name the same recording, so the list is deduplicated.
 */
export function recordingIdsOf(messages: AgentMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const id = recordingIdOf(message);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** What the pane knows about the recordings behind the calls in a thread. */
export type RecordingContext = {
  recordingHref: (recordingId: string) => string;
  recordings: Record<string, RecordingMeta>;
};

/**
 * Remembers when each message was first seen, so the same message keeps the same
 * timestamp for as long as the pane is open.
 *
 * A `UIMessage` carries no time of its own, and the alternatives are both worse than
 * they look. Calling `Date.now()` during the mapping gives every message a new time on
 * every render, which re-runs chatcn's grouping and makes bubble corners flicker as
 * tokens stream in. A single fixed constant instead stamps a conversation spanning an
 * hour as all one minute. First-sight time is exact for anything that arrives while the
 * pane is open — which is the live conversation, the case that matters — and collapses
 * history to the moment it loaded, which reads as "this is what was here when you
 * arrived" rather than as a wrong clock.
 */
export function createTimestampBook(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (id: string): number => {
    const existing = seen.get(id);
    if (existing !== undefined) return existing;
    const at = now();
    seen.set(id, at);
    return at;
  };
}

export type TimestampBook = ReturnType<typeof createTimestampBook>;

/**
 * Agent messages as the conversation renders them. Three kinds come out:
 *
 * - the participant's own turns, attributed to `currentUser` so chatcn lays them out
 *   on the outgoing side;
 * - the start of a call, as a voice note — chatcn's own `voice` message shape, so it
 *   needs no new branch anywhere downstream. It goes in when the call opens rather
 *   than when it ends, which is what makes a call in progress visible in the thread,
 *   and its length and bars are read from `recordings` so the message itself never has
 *   to be rewritten as more audio lands;
 * - a finished voice call, as an `Activity` card — it is something that *happened* in
 *   the conversation rather than something anyone typed, and the transcript behind it
 *   goes in `detail` for whatever opens the card;
 * - everything else from the assistant, as a `PlatformMessage` in dembrane's own blue.
 *
 * Messages that carry no text at all are dropped rather than rendered as empty bubbles.
 */
export function toConversationMessages(
  messages: AgentMessage[],
  currentUser: ChatUser,
  timestampOf: TimestampBook,
  recordingContext?: RecordingContext,
): ConversationMessage[] {
  const out: ConversationMessage[] = [];

  for (const message of messages) {
    const text = textOf(message);
    const timestamp = timestampOf(message.id);

    if (kindOf(message) === "call-started") {
      const recordingId = recordingIdOf(message);
      // Without a recording there is nothing to play, and the marker's own text
      // is for the model to read rather than for anyone to see.
      if (!recordingId || !recordingContext) continue;
      const meta = recordingContext.recordings[recordingId];
      const note: ChatMessageData = {
        id: message.id,
        // The conversation's own device made this recording, so it belongs on
        // the participant's side — and on the host's screen, where
        // `currentUser` is the host, it lands on the other side by itself.
        senderId: currentUser.id,
        senderName: currentUser.name,
        timestamp,
        voice: {
          url: recordingContext.recordingHref(recordingId),
          // Zero until the first segment is flushed, which the player reads as
          // "still being recorded" and counts up from rather than down.
          duration: meta?.durationSec ?? 0,
          waveform: meta?.waveform ?? [],
        },
      };
      out.push(note);
      continue;
    }

    if (!text) continue;

    if (isVoiceCall(message)) {
      const transcript = text.replace(TRANSCRIPT_PREFIX, "");
      const activity: ActivityMessageData = {
        id: message.id,
        senderId: DEMBRANE.id,
        senderName: DEMBRANE.name,
        timestamp,
        activity: {
          title: "Voice call",
          description: summarize(transcript),
          meta: "Click to read the transcript",
          detail: transcript,
        },
      };
      out.push(activity);
      continue;
    }

    if (message.role === "user") {
      const own: ChatMessageData = {
        id: message.id,
        senderId: currentUser.id,
        senderName: currentUser.name,
        text,
        timestamp,
      };
      out.push(own);
      continue;
    }

    const platform: PlatformMessageData = {
      id: message.id,
      senderId: DEMBRANE.id,
      senderName: DEMBRANE.name,
      text,
      timestamp,
      isPlatform: true,
    };
    out.push(platform);
  }

  return out;
}

/**
 * The first line or so of a transcript, for the face of an activity card.
 *
 * Short on purpose: the card is a three-line summary of something that happened, and
 * the whole call is one click away in the drawer `detail` feeds. A limit long enough
 * to be worth reading on its own would make every call the tallest thing in the thread.
 */
function summarize(transcript: string, limit = 80): string {
  const flat = transcript.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The conversation's header subtitle: who is in it, and on how many devices.
 *
 * Each scan of the join code is one device, so a conversation is always one device
 * however many people share it — the participant count is the only part the agent
 * learns, and it is unknown until onboarding asks.
 */
export function describeParticipants(state: ConversationState | null): string {
  const people = state?.participants;
  if (!people) return "1 device";
  return `${people} ${people === 1 ? "participant" : "participants"} (1 device)`;
}

/** One row in the conversation list. */
export type ConversationRow = {
  id: string;
  title: string;
  lastMessage: string;
};

/**
 * The hub's catalog as the sidebar renders it. The fallbacks matter: a conversation
 * exists from the moment its code is scanned, so it is listed before it has a name or
 * a single message in it.
 */
export function toConversationRows(chats: ChatEntry[]): ConversationRow[] {
  return chats.map((chat) => ({
    id: chat.id,
    title: chat.metadata?.title ?? "New conversation",
    lastMessage: chat.metadata?.lastMessage ?? "No messages yet",
  }));
}
