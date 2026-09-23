/**
 * The call as it is being spoken, with its pauses shown.
 *
 * The thread's transcript gets its pause markers on the server, from the gap in
 * the audio itself. The live transcript on `CallScreen` never goes through
 * there: it is built in the browser from what the voice client has heard so
 * far, so the marks have to be put in on the same side — from the mute button,
 * which is what caused the gap the server later measures.
 */

/** A pause, and how far into the transcript the call had got when it began. */
export type LivePause = {
  /** Characters of transcript heard before the microphone went quiet. */
  at: number;
  marker: string;
};

/**
 * `heard` with each pause written in where it happened.
 *
 * The transcript only ever grows by appending, so a character offset taken when
 * the pause began still points at the same place later. An offset past the end
 * belongs to a pause nothing has been said since — which is the normal state
 * for a second or two after unmuting, because the words that follow it are
 * still being transcribed.
 */
export function withPauseMarkers(heard: string, pauses: LivePause[]): string {
  if (pauses.length === 0) return heard;

  const parts: string[] = [];
  let from = 0;
  for (const pause of [...pauses].sort((a, b) => a.at - b.at)) {
    const at = Math.min(Math.max(pause.at, 0), heard.length);
    parts.push(heard.slice(from, at), pause.marker);
    from = at;
  }
  parts.push(heard.slice(from));

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}
