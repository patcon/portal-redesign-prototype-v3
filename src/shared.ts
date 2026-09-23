/**
 * Wire contract shared by the Worker and the browser. This module must
 * stay dependency-free: `client.tsx` imports it, so anything it reaches
 * would be pulled into the browser bundle.
 */

/** Longest message a chat stores. Both sides bound against it. */
export const MAX_TEXT = 2_000;

/** Longest search term the hub accepts. */
export const MAX_QUERY = 200;

/** Sent by the hub to its own sockets whenever the catalog changes. */
export const CHATS_CHANGED = "chats-changed";

/**
 * Whether a message is one of the two a call leaves behind — the voice note it
 * opens with, or the transcript it closes with.
 *
 * Neither is anything a participant typed, so both have to be skipped wherever
 * the app is looking for a conversation's own words: the hub's title heuristic
 * is the one that matters today.
 */
export function isCallMarker(metadata: unknown): boolean {
  const kind = (metadata as { kind?: string } | undefined)?.kind;
  return kind === "call-started" || kind === "voice-call";
}

/** Where a recording's audio and its metadata are served from. */
export function recordingPath(
  eventId: string,
  chatId: string,
  recordingId: string,
  extension: "wav" | "json",
): string {
  return `/recordings/${encodeURIComponent(eventId)}/${encodeURIComponent(chatId)}/${encodeURIComponent(recordingId)}.${extension}`;
}
