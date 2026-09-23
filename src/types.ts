/**
 * Types shared by the Worker and the browser. Like `shared.ts`, this module
 * must stay dependency-free at runtime: `client.tsx` imports it, so anything
 * it reached would be pulled into the browser bundle. Every import here is
 * type-only, so nothing survives compilation.
 */

import type { RoutedAgentEntry } from "agents/routing";

/**
 * The host's private thread is a routed chat like any other — same class,
 * same storage, same socket — distinguished only by this flag. One chat
 * implementation, not two; `RoutedAgents` has a single namespace anyway,
 * so a separate class could not be routed alongside the group chats.
 */
export type ChatKind = "host" | "group";

/** What a chat pushes into its hub, so listing never wakes a chat. */
export type ChatMeta = {
  kind: ChatKind;
  title: string | null;
  lastMessage: string | null;
  /**
   * The tail of the conversation's most recent call, pushed as it is spoken.
   * This is what lets the host read across every conversation without waking
   * any of them;
   * without it, reaching a transcript means drilling into one chat at a time.
   */
  transcript: string | null;
  /**
   * A per-chat push counter. Fences out delayed or superseded pushes without
   * relying on `Date.now()` resolution. It counts pushes rather than messages
   * because a call pushes transcript updates without adding any message.
   */
  seq: number;
};

/** A catalog entry as both the hub and the browser see it. */
export type ChatEntry = RoutedAgentEntry<ChatMeta>;

/** Recorded once by the owning hub right after the entry is created. */
export type ChatOwner = {
  eventId: string;
  chatId: string;
  kind: ChatKind;
};

/**
 * A conversation's synced state. Agent state reaches every connected client,
 * so the conversation's own screen shows its name the moment the agent sets it.
 */
export type ConversationState = { name: string | null; participants: number | null };

/**
 * The two messages that bracket a call, WhatsApp-style.
 *
 * `call-started` goes in as the call opens and carries the recording, so the
 * thread shows a voice note that fills in as people speak. `voice-call` is the
 * transcript left behind at hang-up, and points back at the same recording.
 * Both are tagged so the hub's "what is this conversation called?" heuristic
 * can skip them — neither is anything a participant typed.
 */
export type CallMarkerMetadata =
  | { kind: "call-started"; recordingId: string }
  | { kind: "voice-call"; recordingId?: string; durationSec?: number };

/** A recording as the browser needs it: how long, and how loud, so far. */
export type RecordingMeta = {
  ended: boolean;
  durationSec: number;
  /** One bar per flushed segment, 0-1. Empty until the first few seconds land. */
  waveform: number[];
};

/** One rendered turn in a conversation. */
export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

/** The hub's `RpcTarget`, as seen from the browser. */
export type HubApi = {
  createChat(): Promise<string>;
  ensureHostThread(): Promise<string>;
  describeModel(): Promise<string>;
  joinEvent(): Promise<string>;
  listChats(): Promise<ChatEntry[]>;
  searchChats(query: string): Promise<ChatEntry[]>;
  deleteChat(chatId: string): Promise<boolean>;
};
