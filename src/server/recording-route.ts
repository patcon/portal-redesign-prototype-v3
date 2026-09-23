/**
 * The two public URLs a recording has.
 *
 * - `/recordings/{event}/{chat}/{recording}.wav` — the audio, assembled from
 *   R2 on the way out, playable while the call is still running.
 * - `/recordings/{event}/{chat}/{recording}.json` — how long it is and how loud
 *   it has been, which is what the voice note in the thread draws.
 *
 * `/recordings` rather than something under `/events` because `/events/*` is
 * the client app's own route namespace: claiming it in `run_worker_first` would
 * stop the SPA being served at all.
 *
 * **Who may listen.** Possession of the event id and the conversation's opaque
 * chat id, which is the same bar as the existing "copy this conversation's
 * link" feature — a prototype's answer, not a real one. Worth fixing before
 * this carries anything anyone was promised privacy for.
 */

import { recordingResponse, type RecordingSource } from "./recording-stream";
import type { RecordingMeta } from "../types";

export type RecordingRef = {
  eventId: string;
  chatId: string;
  recordingId: string;
  format: "wav" | "json";
};

/** The recording a URL names, or null if it does not name one. */
export function parseRecordingPath(pathname: string): RecordingRef | null {
  const match = /^\/recordings\/([^/]+)\/([^/]+)\/([^/]+)\.(wav|json)$/.exec(pathname);
  if (!match) return null;

  const [, event, chat, recording, format] = match;
  // Ids are decoded and then only ever compared against rows in the
  // conversation's own database. Nothing here is joined into an R2 key — those
  // come back from the manifest — so a `..` that survives decoding reaches a
  // lookup that misses, not a path.
  const eventId = safeDecode(event);
  const chatId = safeDecode(chat);
  const recordingId = safeDecode(recording);
  if (!eventId || !chatId || !recordingId) return null;

  return { eventId, chatId, recordingId, format: format as "wav" | "json" };
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === "" ? null : decoded;
  } catch {
    // A malformed escape is a malformed URL, not a recording.
    return null;
  }
}

/** Serve a recording, or say why not. */
export async function handleRecording(
  ref: RecordingRef,
  request: Request,
  env: Env,
): Promise<Response> {
  const hub = env.ProjectHub.getByName(ref.eventId);
  const source: RecordingSource = {
    describe: async () => {
      const manifest = await hub.recordingManifest(ref.chatId, ref.recordingId);
      return manifest ?? null;
    },
    body: async (key) => (await env.RECORDINGS.get(key))?.body ?? null,
  };

  if (ref.format === "json") {
    const summary = await source.describe();
    if (!summary) return new Response("No such recording", { status: 404 });
    const meta: RecordingMeta = {
      ended: summary.ended,
      durationSec: summary.durationSec,
      waveform: summary.waveform,
    };
    return Response.json(meta, {
      headers: {
        // A running recording's length changes every couple of seconds, and a
        // finished one is asked for once. Neither is worth a cache.
        "Cache-Control": summary.ended ? "private, max-age=3600" : "no-store",
      },
    });
  }

  return recordingResponse(source, request);
}
