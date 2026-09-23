import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Recorder, type BucketLike, type SqlLike } from "./recording";
import { SAMPLE_RATE } from "./wav";

/**
 * A Durable Object's `ctx.storage.sql`, played by real SQLite.
 *
 * The whole point of `Recorder` taking a `SqlLike` is that the interesting
 * behaviour — what survives a failed upload, what an evicted object finds when
 * it wakes — is storage behaviour, and asserting it against a fake Map would
 * only prove the fake works. `node:sqlite` runs the same statements the DO
 * runs. The one shape to match is DO's cursor: `exec(...).toArray()`.
 */
function sqliteAdapter(db: DatabaseSync): SqlLike {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows.map(asDurableObjectRow) };
    },
  };
}

/**
 * One row, as a Durable Object would hand it back rather than as `node:sqlite`
 * does.
 *
 * The two disagree about BLOBs: DO SQLite returns an `ArrayBuffer`, Node
 * returns a `Uint8Array`. That difference is not cosmetic — `TypedArray.set`
 * accepts the second and silently copies *nothing* from the first, because an
 * `ArrayBuffer` has no `length`. Every segment is then the right size and
 * entirely zeroes, which is a recording of perfect silence that plays, reports
 * the right duration, and is wrong. So the fake converts, and the tests below
 * are run against the shape production actually produces.
 */
function asDurableObjectRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Uint8Array
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value;
  }
  return out;
}

/** An R2 bucket that keeps its objects in a Map, and can be told to fail. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  let failNext = 0;
  return {
    objects,
    failNextPut(times = 1) {
      failNext = times;
    },
    bucket: {
      async put(key: string, value: Uint8Array) {
        if (failNext > 0) {
          failNext -= 1;
          throw new Error("R2 said no");
        }
        objects.set(key, new Uint8Array(value));
      },
      async get(key: string) {
        const value = objects.get(key);
        if (!value) return null;
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(value);
              controller.close();
            },
          }),
        };
      },
    } satisfies BucketLike,
  };
}

/** `bytes` of audible PCM, so a peak reads above zero. */
function pcm(bytes: number, amplitude = 16384): ArrayBuffer {
  const samples = new Int16Array(bytes / 2);
  samples.fill(amplitude);
  return samples.buffer;
}

const CHAT = "chat-1";
const SEGMENT_BYTES = 6400;

describe("Recorder", () => {
  let db: DatabaseSync;
  let r2: ReturnType<typeof fakeBucket>;
  let recorder: Recorder;

  /** A second Recorder over the same database: what an evicted object wakes as. */
  function reopen() {
    const next = new Recorder(sqliteAdapter(db), r2.bucket, { segmentBytes: SEGMENT_BYTES });
    next.ensureSchema();
    return next;
  }

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    r2 = fakeBucket();
    recorder = new Recorder(sqliteAdapter(db), r2.bucket, { segmentBytes: SEGMENT_BYTES });
    recorder.ensureSchema();
  });

  it("creates its schema idempotently", () => {
    expect(() => recorder.ensureSchema()).not.toThrow();
    expect(() => reopen()).not.toThrow();
  });

  describe("opening and attaching", () => {
    it("gives a session one recording, and finds it again by session", () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      expect(recorder.forSession("session-a")).toBe(id);
      expect(recorder.forSession("session-b")).toBeNull();
    });

    it("returns the same recording when a resumed call opens again", () => {
      const first = recorder.open("session-a", "conn-1", CHAT);
      const second = recorder.open("session-a", "conn-1", CHAT);
      expect(second.recordingId).toBe(first.recordingId);
    });

    it("finds a session's recording after an eviction, without opening a second", () => {
      const { recordingId } = recorder.open("session-a", "conn-1", CHAT);
      // The in-memory memo is gone; only SQLite survives.
      expect(reopen().forSession("session-a")).toBe(recordingId);
    });

    it("says whether the recording is new, so a resumed call posts no second note", () => {
      expect(recorder.open("session-a", "conn-1", CHAT).fresh).toBe(true);
      expect(recorder.open("session-a", "conn-1", CHAT).fresh).toBe(false);
    });

    it("keeps one recording when a call resumes under a new transcriber session", () => {
      const first = recorder.open("session-a", "conn-1", CHAT);

      // An evicted call wakes with the same WebSocket but a freshly created
      // transcriber session, so the session id is not what identifies the call.
      const resumed = reopen().open("session-b", "conn-1", CHAT);

      expect(resumed).toEqual({ recordingId: first.recordingId, fresh: false });
    });

    it("routes audio from the resumed session into the same recording", () => {
      const { recordingId } = recorder.open("session-a", "conn-1", CHAT);
      const woken = reopen();
      woken.open("session-b", "conn-1", CHAT);

      expect(woken.forSession("session-b")).toBe(recordingId);
    });

    it("gives a genuinely different call its own recording", () => {
      const first = recorder.open("session-a", "conn-1", CHAT);
      const second = recorder.open("session-b", "conn-2", CHAT);

      expect(second.recordingId).not.toBe(first.recordingId);
      expect(second.fresh).toBe(true);
    });

    it("does not adopt a finished call's recording when the same device calls again", async () => {
      const first = recorder.open("session-a", "conn-1", CHAT);
      await recorder.end(first.recordingId);

      const second = recorder.open("session-b", "conn-1", CHAT);
      expect(second.fresh).toBe(true);
      expect(second.recordingId).not.toBe(first.recordingId);
    });
  });

  describe("append", () => {
    it("asks for a flush only once the segment threshold is crossed", () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      expect(recorder.append(id, pcm(SEGMENT_BYTES / 2))).toBe(false);
      expect(recorder.append(id, pcm(SEGMENT_BYTES / 2))).toBe(true);
    });

    it("rebuilds its byte count from SQLite after an eviction", () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES / 2));
      // A woken object must not think the buffer is empty and under-flush.
      expect(reopen().append(id, pcm(SEGMENT_BYTES / 2))).toBe(true);
    });

    it("ignores audio for a recording that was never opened", () => {
      expect(recorder.append("nope", pcm(64))).toBe(false);
    });
  });

  describe("flush", () => {
    it("writes one R2 object and clears the staged rows", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES));
      await recorder.flush(id);

      expect([...r2.objects.keys()]).toEqual([`recordings/${CHAT}/${id}/00000.pcm`]);
      expect(r2.objects.get(`recordings/${CHAT}/${id}/00000.pcm`)).toHaveLength(SEGMENT_BYTES);
      expect(db.prepare("SELECT COUNT(*) AS n FROM rec_pending").get()).toEqual({ n: 0 });
    });

    it("does nothing when there is nothing staged", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      await recorder.flush(id);
      expect(r2.objects.size).toBe(0);
    });

    it("keeps the staged audio when the upload fails", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES));
      r2.failNextPut();
      await recorder.flush(id);

      expect(r2.objects.size).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM rec_pending").get()).toEqual({ n: 1 });
      expect(recorder.describe(id)?.segments).toEqual([]);
    });

    it("retries a failed upload into the same sequence, not the next one", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES));
      r2.failNextPut();
      await recorder.flush(id);
      await recorder.flush(id);

      expect([...r2.objects.keys()]).toEqual([`recordings/${CHAT}/${id}/00000.pcm`]);
      expect(recorder.describe(id)?.segments).toHaveLength(1);
    });

    it("numbers segments in order and records where each one starts", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES));
      await recorder.flush(id);
      recorder.append(id, pcm(SEGMENT_BYTES));
      await recorder.flush(id);
      recorder.append(id, pcm(100));
      await recorder.flush(id);

      expect(recorder.describe(id)?.segments).toEqual([
        { seq: 0, key: `recordings/${CHAT}/${id}/00000.pcm`, bytes: SEGMENT_BYTES, offset: 0 },
        {
          seq: 1,
          key: `recordings/${CHAT}/${id}/00001.pcm`,
          bytes: SEGMENT_BYTES,
          offset: SEGMENT_BYTES,
        },
        {
          seq: 2,
          key: `recordings/${CHAT}/${id}/00002.pcm`,
          bytes: 100,
          offset: SEGMENT_BYTES * 2,
        },
      ]);
    });

    it("joins the staged chunks back into one object, in order", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, new Int16Array([1, 2]).buffer);
      recorder.append(id, new Int16Array([3, 4]).buffer);
      await recorder.flush(id);

      const stored = r2.objects.get(`recordings/${CHAT}/${id}/00000.pcm`)!;
      expect([...new Int16Array(stored.buffer, stored.byteOffset, 4)]).toEqual([1, 2, 3, 4]);
    });

    it("runs overlapping flushes one at a time", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES));
      // Both calls see staged rows; only the first may turn them into a segment.
      await Promise.all([recorder.flush(id), recorder.flush(id)]);
      expect(r2.objects.size).toBe(1);
    });
  });

  describe("the summary a recording reports", () => {
    it("is null for a recording nobody opened", () => {
      expect(recorder.describe("nope")).toBeNull();
    });

    it("reports a recording in progress as unended, with a bar per segment", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES, 32767));
      await recorder.flush(id);

      const summary = recorder.describe(id)!;
      expect(summary.ended).toBe(false);
      expect(summary.totalBytes).toBe(SEGMENT_BYTES);
      expect(summary.durationSec).toBeCloseTo(SEGMENT_BYTES / (SAMPLE_RATE * 2), 5);
      expect(summary.waveform).toHaveLength(1);
      expect(summary.waveform[0]).toBeCloseTo(1, 2);
    });

    it("keeps a quiet segment's bar below a loud one's", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(SEGMENT_BYTES, 32767));
      await recorder.flush(id);
      recorder.append(id, pcm(SEGMENT_BYTES, 1000));
      await recorder.flush(id);

      const [loud, quiet] = recorder.describe(id)!.waveform;
      expect(quiet).toBeLessThan(loud);
    });
  });

  describe("end", () => {
    it("flushes what is left and marks the recording finished", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      recorder.append(id, pcm(1600));
      const summary = await recorder.end(id);

      expect(summary.totalBytes).toBe(1600);
      expect(summary.ended).toBe(true);
      expect(r2.objects.size).toBe(1);
      expect(recorder.describe(id)?.ended).toBe(true);
    });

    it("leaves no open recording behind for the session", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      await recorder.end(id);
      expect(recorder.openRecordings()).toEqual([]);
    });

    it("lists a recording as open until it ends, so a stalled call can be flushed", () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      expect(recorder.openRecordings()).toEqual([id]);
    });
  });

  describe("abandoned", () => {
    it("leaves a recording alone while its connection is still there", () => {
      recorder.open("session-a", "conn-1", CHAT);
      expect(recorder.abandoned(["conn-1"])).toEqual([]);
    });

    it("reports a recording whose connection is gone", () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      // What an object finds when it wakes after a crash mid-call: the
      // recording is still open, and the socket that was filling it is not.
      expect(recorder.abandoned([])).toEqual([{ id, connectionId: "conn-1" }]);
    });

    it("reports nothing once the recording has ended", async () => {
      const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
      await recorder.end(id);
      expect(recorder.abandoned([])).toEqual([]);
    });

    it("keeps one call's recording while another's connection is gone", () => {
      recorder.open("session-a", "conn-1", CHAT);
      const { recordingId: dropped } = recorder.open("session-b", "conn-2", CHAT);
      expect(recorder.abandoned(["conn-1"])).toEqual([
        { id: dropped, connectionId: "conn-2" },
      ]);
    });
  });

  it("never throws out of the audio path when R2 is down", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordingId: id } = recorder.open("session-a", "conn-1", CHAT);
    recorder.append(id, pcm(SEGMENT_BYTES));
    r2.failNextPut(5);
    await expect(recorder.flush(id)).resolves.toBeUndefined();
    await expect(recorder.end(id)).resolves.toMatchObject({ ended: true });
    warn.mockRestore();
  });
});
