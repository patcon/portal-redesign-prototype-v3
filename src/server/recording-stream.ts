/**
 * Serving a recording as one WAV, assembled from its R2 segments on the way out.
 *
 * Nothing is stored in WAV form. The segments are raw PCM exactly as the voice
 * socket sent it, and the header is made here, per request — which is what
 * makes a recording playable *while it is still being made*: a live request
 * declares an unknown length and keeps reading as new segments land, and the
 * same route serves the finished thing with a real length and seeking.
 *
 * The audio goes R2 → client. The Durable Object is asked for metadata and
 * nothing else, so a long recording never passes through it.
 */

import type { RecordingSummary } from "./recording";
import { STREAMING_SIZE, wavHeader } from "./wav";

/** Where the metadata and the bytes come from. */
export type RecordingSource = {
  describe(): Promise<RecordingSummary | null>;
  body(key: string): Promise<ReadableStream<Uint8Array> | null>;
};

export type ByteRange = { start: number; end: number };

/** A stretch of one segment: `[from, to)` within that segment's own bytes. */
export type SegmentSlice = { key: string; from: number; to: number };

/** How long to wait before asking a running recording for more audio. */
const POLL_MS = 1000;

/** Safety valve: a recording whose object died without ever ending. */
const MAX_POLLS = 60 * 60;

/**
 * A `Range` header against a body of `length` bytes.
 *
 * Returns null when there is no usable range (serve the whole body), a range,
 * or `"unsatisfiable"` when the client asked for bytes that do not exist.
 */
export function parseRange(
  header: string | null,
  length: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }

  const start = Number(rawStart);
  if (start >= length) return "unsatisfiable";
  const end = rawEnd === "" ? length - 1 : Math.min(Number(rawEnd), length - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * The parts of each segment covered by `[start, end]`, in PCM coordinates —
 * that is, with the WAV header already subtracted by the caller.
 */
export function sliceSegments(
  segments: RecordingSummary["segments"],
  start: number,
  end: number,
): SegmentSlice[] {
  const slices: SegmentSlice[] = [];
  for (const segment of segments) {
    const segmentEnd = segment.offset + segment.bytes;
    if (segmentEnd <= start || segment.offset > end) continue;
    slices.push({
      key: segment.key,
      from: Math.max(0, start - segment.offset),
      to: Math.min(segment.bytes, end - segment.offset + 1),
    });
  }
  return slices;
}

/**
 * The whole recording, or the requested part of it, as a response.
 *
 * `sleep` is injectable only so the live-polling path can be tested without
 * spending a second per segment.
 */
export async function recordingResponse(
  source: RecordingSource,
  request: Request,
  options?: { sleep?: (ms: number) => Promise<void> },
): Promise<Response> {
  const sleep = options?.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const summary = await source.describe();
  if (!summary) return new Response("No such recording", { status: 404 });

  const header = wavHeader(summary.ended ? summary.totalBytes : STREAMING_SIZE);
  const length = header.byteLength + summary.totalBytes;

  // A recording still being written has no length to range over: the client is
  // listening in, not seeking, and the next poll may add more audio.
  if (!summary.ended) {
    return new Response(liveStream(source, header, sleep), {
      headers: {
        "Content-Type": "audio/wav",
        // The playlist-equivalent problem: a cached live body would be stale
        // the moment the next segment lands.
        "Cache-Control": "no-store",
      },
    });
  }

  const range = parseRange(request.headers.get("Range"), length);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${length}`, "Accept-Ranges": "bytes" },
    });
  }

  const { start, end } = range ?? { start: 0, end: length - 1 };
  const body = finishedStream(source, header, summary, start, end);
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    // A finished recording's bytes never change, but it is somebody's
    // conversation, so it is cached by the browser and not by anything shared.
    "Cache-Control": "private, max-age=3600",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${length}`;

  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Header then segments, trimmed to `[start, end]` of the assembled body. */
function finishedStream(
  source: RecordingSource,
  header: Uint8Array,
  summary: RecordingSummary,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (start < header.byteLength) {
          controller.enqueue(header.subarray(start, Math.min(header.byteLength, end + 1)));
        }
        const slices = sliceSegments(
          summary.segments,
          Math.max(0, start - header.byteLength),
          end - header.byteLength,
        );
        for (const slice of slices) {
          await pump(source, slice, controller);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/**
 * Header then every segment as it appears, until the recording ends.
 *
 * Holding the response open for the length of a call is fine: Workers are
 * billed for CPU, not for how long a body takes to drain.
 */
function liveStream(
  source: RecordingSource,
  header: Uint8Array,
  sleep: (ms: number) => Promise<void>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(header);
        let sent = 0;
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          const summary = await source.describe();
          if (!summary) break;

          for (const segment of summary.segments.slice(sent)) {
            await pump(source, { key: segment.key, from: 0, to: segment.bytes }, controller);
            sent += 1;
          }
          // Ended *and* drained — a recording can end with segments this
          // stream has not sent yet.
          if (summary.ended && sent >= summary.segments.length) break;
          await sleep(POLL_MS);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** One segment's bytes, trimmed to the slice, into the response. */
async function pump(
  source: RecordingSource,
  slice: SegmentSlice,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const body = await source.body(slice.key);
  // A missing object means lifecycle expiry or a half-written recording.
  // Skipping it keeps the rest playable rather than failing the whole request.
  if (!body) return;

  const reader = body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkStart = at;
    at += value.byteLength;
    const from = Math.max(slice.from, chunkStart);
    const to = Math.min(slice.to, at);
    if (to > from) controller.enqueue(value.subarray(from - chunkStart, to - chunkStart));
    if (at >= slice.to) {
      await reader.cancel();
      break;
    }
  }
}
