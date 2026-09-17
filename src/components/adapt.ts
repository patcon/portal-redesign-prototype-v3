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
import type { ChatEntry } from "../types";

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
  return (message.metadata as { kind?: string } | undefined)?.kind === "voice-call";
}

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
): ConversationMessage[] {
  const out: ConversationMessage[] = [];

  for (const message of messages) {
    const text = textOf(message);
    if (!text) continue;
    const timestamp = timestampOf(message.id);

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

/** The first line or so of a transcript, for the face of an activity card. */
function summarize(transcript: string, limit = 120): string {
  const flat = transcript.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
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
