/**
 * A call's audio, on its way from the voice socket to R2.
 *
 * The audio arrives as raw PCM in ~3 KB frames, ten a second, and must not sit
 * in the Durable Object any longer than it has to. So this stages a couple of
 * seconds in the conversation's own SQLite and writes one small R2 object at a
 * time: an eviction mid-call loses at most the unflushed tail, and R2 holds
 * everything before it.
 *
 * ## Why this lives in the chat's own object
 *
 * A dedicated recording DO was the first instinct and is the wrong shape here.
 * At 32 KB/s one small `INSERT` per frame and one `put` every couple of seconds
 * is nowhere near where a single-threaded object struggles; an R2 `put` is a
 * `fetch` rather than a storage op, so it does not close the input gate and
 * chat messages keep flowing while a segment uploads; and the object is already
 * awake holding the call's WebSocket, so nothing is saved by moving the work.
 * Staying in one object is also what lets a segment row and the transcript it
 * belongs to commit together. Revisit if recordings ever carry several
 * simultaneous speakers.
 *
 * ## Why not R2 multipart upload
 *
 * Every part but the last has a 5 MiB minimum, which at this bitrate is about
 * three minutes of audio held in memory before any of it becomes durable —
 * exactly the opposite of what staging is for.
 *
 * ## Ports rather than bindings
 *
 * `SqlLike` and `BucketLike` are the narrow slices of `ctx.storage.sql` and
 * `R2Bucket` this needs. Both real objects satisfy them structurally, and the
 * tests can hand over real SQLite and a bucket that fails on demand — which is
 * the only way to prove that a failed upload leaves the audio staged.
 */

import { BYTES_PER_SAMPLE, durationSeconds, peakOf, SAMPLE_RATE } from "./wav";

/** The slice of `DurableObjectStorage["sql"]` a recording needs. */
export type SqlLike = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

/** The slice of `R2Bucket` a recording needs. */
export type BucketLike = {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
};

/** One flushed R2 object, and where it sits in the recording. */
export type Segment = {
  seq: number;
  key: string;
  bytes: number;
  /** Byte offset of this segment within the whole recording. */
  offset: number;
};

/** A recording as the playback route and the voice note see it. */
export type RecordingSummary = {
  id: string;
  ended: boolean;
  /** Bytes flushed to R2. The unflushed tail is deliberately not counted. */
  totalBytes: number;
  durationSec: number;
  /** One bar per segment, 0–1. */
  waveform: number[];
  segments: Segment[];
};

/**
 * How much audio to stage before writing a segment: ~2 s at 16 kHz mono 16-bit.
 *
 * Short on purpose. A listener on a call in progress is always at most one
 * unflushed segment behind, so this is the live-playback lag, and at these
 * sizes the extra writes cost nothing worth counting.
 */
const SEGMENT_BYTES = 64_000;

/** Schema version currently applied by {@link Recorder.ensureSchema}. */
const SCHEMA_VERSION = 1;

type RecordingRow = {
  id: string;
  chat_id: string;
  session_id: string;
  connection_id: string;
  ended_at: number | null;
  bytes: number;
  next_seq: number;
};

export class Recorder {
  #sql: SqlLike;
  #bucket: BucketLike;
  #segmentBytes: number;

  /**
   * Which recording a transcriber session is feeding, in memory.
   *
   * Audio arrives ten times a second, and a storage *read* closes the input
   * gate — asking SQLite on every frame would stall chat messages behind the
   * lookup. A miss falls back to SQLite once, which is what a woken object
   * does, and then this answers.
   */
  #bySession = new Map<string, string>();

  /**
   * Staged bytes per recording, in memory for the same reason: `SUM()` per
   * frame would be a read per frame. `null`/absent means "ask SQLite once".
   */
  #buffered = new Map<string, number>();

  /**
   * Flushes, one at a time. Two overlapping flushes would both read the same
   * staged rows and write them twice. Never `blockConcurrencyWhile` — a throw
   * inside that resets the whole object, and a flaky upload is not worth the
   * chat going down.
   */
  #chain: Promise<void> = Promise.resolve();

  constructor(sql: SqlLike, bucket: BucketLike, options?: { segmentBytes?: number }) {
    this.#sql = sql;
    this.#bucket = bucket;
    this.#segmentBytes = options?.segmentBytes ?? SEGMENT_BYTES;
  }

  /**
   * Create the tables this needs, once per conversation.
   *
   * Additive and forward-only: there is no central database to migrate, only N
   * independent ones that each upgrade whenever their conversation next wakes,
   * so there is no moment at which a rollback could be coordinated. An unused
   * column left behind by a reverted deploy is harmless; a dropped one is not.
   *
   * The version lives in a table because DO SQLite does not support
   * `PRAGMA user_version`. Tables are `rec_`-prefixed so they cannot collide
   * with the agents SDK's own.
   */
  ensureSchema(): void {
    this.#sql.exec("CREATE TABLE IF NOT EXISTS rec_schema (version INTEGER PRIMARY KEY)");
    const applied = new Set(
      this.#sql
        .exec("SELECT version FROM rec_schema")
        .toArray()
        .map((row) => Number(row.version)),
    );

    if (!applied.has(1)) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS rec_recordings (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        bytes INTEGER NOT NULL DEFAULT 0,
        next_seq INTEGER NOT NULL DEFAULT 0
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS rec_pending (
        recording TEXT NOT NULL,
        seq INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (recording, seq)
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS rec_segments (
        recording TEXT NOT NULL,
        seq INTEGER NOT NULL,
        key TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        peak REAL NOT NULL,
        PRIMARY KEY (recording, seq)
      )`);
      this.#sql.exec("INSERT INTO rec_schema (version) VALUES (?)", SCHEMA_VERSION);
    }
  }

  /**
   * The recording a transcriber session is feeding, or null.
   *
   * Null is the normal answer for a frame that arrives before the call has
   * started, and the caller should drop it rather than open a recording it
   * cannot name.
   */
  forSession(sessionId: string): string | null {
    const cached = this.#bySession.get(sessionId);
    if (cached) return cached;

    const [row] = this.#sql
      .exec(
        "SELECT id FROM rec_recordings WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        sessionId,
      )
      .toArray() as { id: string }[];
    if (!row) return null;
    this.#bySession.set(sessionId, row.id);
    return row.id;
  }

  /**
   * Start recording this call, or adopt the recording it already has.
   *
   * `fresh` is false when this call was already being recorded, which is the
   * caller's cue not to announce it a second time.
   *
   * The call is identified by its **connection**, not by its transcriber
   * session. The voice mixin calls `onCallStart` again when a call survives an
   * eviction, and the session it creates on the way back is a new one — so
   * matching on the session would open a second recording and split one call
   * into two voice notes, with the transcript pointing at the wrong half. The
   * WebSocket survives the eviction; the session does not.
   */
  open(
    sessionId: string,
    connectionId: string,
    chatId: string,
  ): { recordingId: string; fresh: boolean } {
    const [open] = this.#sql
      .exec(
        "SELECT id FROM rec_recordings WHERE connection_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        connectionId,
      )
      .toArray() as { id: string }[];

    if (open) {
      // Point the new session at the recording already in progress, so the
      // audio arriving under it lands in the same place as before the eviction.
      this.#sql.exec("UPDATE rec_recordings SET session_id = ? WHERE id = ?", sessionId, open.id);
      this.#bySession.set(sessionId, open.id);
      return { recordingId: open.id, fresh: false };
    }

    const id = crypto.randomUUID();
    this.#sql.exec(
      "INSERT INTO rec_recordings (id, chat_id, session_id, connection_id, started_at) VALUES (?, ?, ?, ?, ?)",
      id,
      chatId,
      sessionId,
      connectionId,
      Date.now(),
    );
    this.#bySession.set(sessionId, id);
    this.#buffered.set(id, 0);
    return { recordingId: id, fresh: true };
  }

  /**
   * Stage one frame of audio. **Synchronous, and on the hot path.**
   *
   * Returns whether enough is staged to be worth a segment; the caller starts
   * the flush without awaiting it, because this runs inside the transcriber's
   * `feed` and must not make the voice pipeline wait on R2.
   */
  append(recordingId: string, chunk: ArrayBuffer): boolean {
    const seq = this.#nextPendingSeq(recordingId);
    if (seq === null) return false;

    this.#sql.exec(
      "INSERT INTO rec_pending (recording, seq, bytes) VALUES (?, ?, ?)",
      recordingId,
      seq,
      new Uint8Array(chunk),
    );
    const buffered = this.#bufferedBytes(recordingId) + chunk.byteLength;
    this.#buffered.set(recordingId, buffered);
    return buffered >= this.#segmentBytes;
  }

  /** Write everything staged for this recording to R2 as one object. */
  flush(recordingId: string): Promise<void> {
    this.#chain = this.#chain.then(() =>
      this.#flushOnce(recordingId).catch((error: unknown) => {
        // Left staged on purpose: the next flush, or the stalled-call
        // heartbeat, picks the same bytes up and writes the same sequence.
        console.error(`[rec] ${recordingId}: segment upload failed —`, error);
      }),
    );
    return this.#chain;
  }

  /** Flush the tail and close the recording. */
  async end(recordingId: string): Promise<RecordingSummary> {
    await this.flush(recordingId);
    this.#sql.exec(
      "UPDATE rec_recordings SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
      Date.now(),
      recordingId,
    );
    this.#buffered.delete(recordingId);
    for (const [session, id] of this.#bySession) {
      if (id === recordingId) this.#bySession.delete(session);
    }
    return (
      this.describe(recordingId) ?? {
        id: recordingId,
        ended: true,
        totalBytes: 0,
        durationSec: 0,
        waveform: [],
        segments: [],
      }
    );
  }

  /** Metadata only: the audio itself goes R2 → client, never through here. */
  describe(recordingId: string): RecordingSummary | null {
    const row = this.#recording(recordingId);
    if (!row) return null;

    const rows = this.#sql
      .exec(
        "SELECT seq, key, bytes, offset, peak FROM rec_segments WHERE recording = ? ORDER BY seq",
        recordingId,
      )
      .toArray() as { seq: number; key: string; bytes: number; offset: number; peak: number }[];

    return {
      id: recordingId,
      ended: row.ended_at !== null,
      totalBytes: Number(row.bytes),
      durationSec: durationSeconds(Number(row.bytes)),
      waveform: rows.map((segment) => Number(segment.peak)),
      segments: rows.map((segment) => ({
        seq: Number(segment.seq),
        key: segment.key,
        bytes: Number(segment.bytes),
        offset: Number(segment.offset),
      })),
    };
  }

  /** Recordings that never got a hang-up, for the stalled-call heartbeat. */
  openRecordings(): string[] {
    return (
      this.#sql
        .exec("SELECT id FROM rec_recordings WHERE ended_at IS NULL ORDER BY started_at")
        .toArray() as { id: string }[]
    ).map((row) => row.id);
  }

  /** Read one segment's bytes back, for the playback route. */
  segmentBody(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null> {
    return this.#bucket.get(key);
  }

  async #flushOnce(recordingId: string): Promise<void> {
    const row = this.#recording(recordingId);
    if (!row) return;

    const staged = (
      this.#sql
        .exec("SELECT seq, bytes FROM rec_pending WHERE recording = ? ORDER BY seq", recordingId)
        .toArray() as { seq: number; bytes: ArrayBuffer | Uint8Array }[]
    ).map((row) => ({ seq: Number(row.seq), bytes: asBytes(row.bytes) }));
    if (staged.length === 0) return;

    const total = staged.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of staged) {
      body.set(chunk.bytes, at);
      at += chunk.bytes.byteLength;
    }

    const seq = Number(row.next_seq);
    const key = segmentKey(row.chat_id, recordingId, seq);
    // If this throws, nothing below runs: the staged rows stay put and
    // `next_seq` does not move, so the retry writes this same segment.
    await this.#bucket.put(key, body);

    const lastSeq = staged[staged.length - 1].seq;
    this.#sql.exec(
      "DELETE FROM rec_pending WHERE recording = ? AND seq <= ?",
      recordingId,
      lastSeq,
    );
    this.#sql.exec(
      "INSERT INTO rec_segments (recording, seq, key, bytes, offset, peak) VALUES (?, ?, ?, ?, ?, ?)",
      recordingId,
      seq,
      key,
      total,
      Number(row.bytes),
      peakOf(body),
    );
    this.#sql.exec(
      "UPDATE rec_recordings SET next_seq = ?, bytes = ? WHERE id = ?",
      seq + 1,
      Number(row.bytes) + total,
      recordingId,
    );
    this.#buffered.set(recordingId, 0);
  }

  #recording(recordingId: string): RecordingRow | null {
    const [row] = this.#sql
      .exec("SELECT * FROM rec_recordings WHERE id = ?", recordingId)
      .toArray() as RecordingRow[];
    return row ?? null;
  }

  /**
   * The next staging slot, or null if this recording does not exist.
   *
   * Counts from the staged rows rather than a column so a retry after a failed
   * upload keeps appending after whatever is still staged.
   */
  #nextPendingSeq(recordingId: string): number | null {
    if (!this.#buffered.has(recordingId) && !this.#recording(recordingId)) return null;
    const [row] = this.#sql
      .exec("SELECT MAX(seq) AS last FROM rec_pending WHERE recording = ?", recordingId)
      .toArray() as { last: number | null }[];
    return row?.last === null || row?.last === undefined ? 0 : Number(row.last) + 1;
  }

  /** Staged bytes, from memory, rebuilt from SQLite the first time after a wake. */
  #bufferedBytes(recordingId: string): number {
    const cached = this.#buffered.get(recordingId);
    if (cached !== undefined) return cached;

    const [row] = this.#sql
      .exec(
        "SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS total FROM rec_pending WHERE recording = ?",
        recordingId,
      )
      .toArray() as { total: number }[];
    const total = Number(row?.total ?? 0);
    this.#buffered.set(recordingId, total);
    return total;
  }
}

/**
 * A BLOB read back out of SQLite, as bytes you can actually copy.
 *
 * Durable Object SQLite hands a BLOB back as an `ArrayBuffer`; `node:sqlite`,
 * which the tests run against, hands back a `Uint8Array`. The difference is
 * quiet and expensive: `TypedArray.set` accepts a `Uint8Array` and copies it,
 * and accepts an `ArrayBuffer` and copies *nothing*, because an `ArrayBuffer`
 * has no `length` for it to read. Every segment then comes out the right size
 * and full of zeroes — a recording that plays, reports the right duration, and
 * is 43 seconds of silence.
 */
function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Where one segment lives. `chatId` in the path makes a whole conversation's
 * audio one prefix — for lifecycle rules, and for deleting a conversation. */
export function segmentKey(chatId: string, recordingId: string, seq: number): string {
  return `recordings/${chatId}/${recordingId}/${String(seq).padStart(5, "0")}.pcm`;
}

/** Bytes per second of the format the voice socket sends. */
export const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
