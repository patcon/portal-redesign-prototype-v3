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

/**
 * The break a pause leaves in a transcript, as the transcript spells it.
 *
 * Muting stops the client sending audio, so what someone said before a pause
 * and what they said after it run together as one sentence — and a reader has
 * no way to tell that anything is missing. The recording gets a pair of pops in
 * the seam; this is the same mark for the words.
 *
 * `m:ss`, `h:mm:ss` from an hour on, matching the call timer, so the same
 * length of time is written the same way wherever it is shown.
 */
export function pauseMarker(pausedMs: number): string {
  const seconds = Math.round(pausedMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, "0");

  const clock =
    hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
      : `${minutes}:${pad(seconds % 60)}`;
  return `[paused ${clock}]`;
}
