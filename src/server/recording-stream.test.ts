import { describe, expect, it, vi } from "vitest";
import type { RecordingSummary } from "./recording";
import { parseRange, recordingResponse, sliceSegments } from "./recording-stream";
import { STREAMING_SIZE } from "./wav";

/** A summary with segments laid end to end, each `bytes` long. */
function summary(sizes: number[], ended = true): RecordingSummary {
  let offset = 0;
  const segments = sizes.map((bytes, seq) => {
    const segment = { seq, key: `seg-${seq}`, bytes, offset };
    offset += bytes;
    return segment;
  });
  return {
    id: "rec-1",
    ended,
    totalBytes: offset,
    durationSec: offset / 32000,
    waveform: sizes.map(() => 0.5),
    segments,
  };
}

/** A source whose segments are runs of a per-segment byte value. */
function source(summaries: (RecordingSummary | null)[]) {
  const queue = [...summaries];
  let last = summaries.at(-1) ?? null;
  return {
    describeCalls: 0,
    async describe() {
      this.describeCalls += 1;
      if (queue.length > 1) last = queue.shift()!;
      else last = queue[0] ?? last;
      return last;
    },
    async body(key: string) {
      const seq = Number(key.split("-")[1]);
      const size = last?.segments.find((s) => s.key === key)?.bytes ?? 0;
      const bytes = new Uint8Array(size).fill(seq + 1);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}

async function collect(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe("parseRange", () => {
  it("is null when the client asked for the whole thing", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=", 100)).toBeNull();
  });

  it("reads an explicit span", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  });

  it("runs an open-ended span to the last byte", () => {
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  it("reads a suffix span from the end", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  it("clamps a span that runs past the end", () => {
    expect(parseRange("bytes=50-999", 100)).toEqual({ start: 50, end: 99 });
  });

  it("rejects a span that starts past the end", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
  });
});

describe("sliceSegments", () => {
  const segments = summary([100, 100, 100]).segments;

  it("takes whole segments when the span covers them", () => {
    expect(sliceSegments(segments, 0, 299)).toEqual([
      { key: "seg-0", from: 0, to: 100 },
      { key: "seg-1", from: 0, to: 100 },
      { key: "seg-2", from: 0, to: 100 },
    ]);
  });

  it("trims the first and last segment to the span", () => {
    expect(sliceSegments(segments, 50, 249)).toEqual([
      { key: "seg-0", from: 50, to: 100 },
      { key: "seg-1", from: 0, to: 100 },
      { key: "seg-2", from: 0, to: 50 },
    ]);
  });

  it("skips segments the span does not reach", () => {
    // 120-180 inclusive is bytes 20..80 of segment 1, so the exclusive end is 81.
    expect(sliceSegments(segments, 120, 180)).toEqual([{ key: "seg-1", from: 20, to: 81 }]);
  });

  it("is empty for a span past the last segment", () => {
    expect(sliceSegments(segments, 300, 400)).toEqual([]);
  });
});

describe("recordingResponse", () => {
  it("is 404 for a recording that does not exist", async () => {
    const response = await recordingResponse(source([null]), new Request("https://x/r.wav"));
    expect(response.status).toBe(404);
  });

  it("serves a finished recording as a header plus every segment, in order", async () => {
    const response = await recordingResponse(
      source([summary([4, 4])]),
      new Request("https://x/r.wav"),
    );
    const body = await collect(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(response.headers.get("Content-Length")).toBe("52"); // 44 + 8
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(String.fromCharCode(...body.subarray(0, 4))).toBe("RIFF");
    expect([...body.subarray(44)]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("declares the real length of a finished recording in its header", async () => {
    const response = await recordingResponse(
      source([summary([4, 4])]),
      new Request("https://x/r.wav"),
    );
    const body = await collect(response);
    expect(new DataView(body.buffer).getUint32(40, true)).toBe(8);
  });

  it("declares an unknown length while the recording is still running", async () => {
    const live = source([summary([4], false)]);
    const response = await recordingResponse(live, new Request("https://x/r.wav"), {
      sleep: async () => {},
    });
    // Streaming: no length to promise, and nothing to cache.
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps a live stream open and picks up segments written after it started", async () => {
    const live = source([summary([4], false), summary([4, 4], false), summary([4, 4], true)]);
    const response = await recordingResponse(live, new Request("https://x/r.wav"), {
      sleep: async () => {},
    });
    const body = await collect(response);

    expect(new DataView(body.buffer).getUint32(40, true)).toBe(STREAMING_SIZE);
    expect([...body.subarray(44)]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("stops polling once the recording ends and its segments are drained", async () => {
    const live = source([summary([4], false), summary([4], true)]);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const response = await recordingResponse(live, new Request("https://x/r.wav"), { sleep });
    await collect(response);
    expect(sleep.mock.calls.length).toBeLessThan(5);
  });

  describe("range requests", () => {
    it("serves a span from the middle of the audio", async () => {
      const response = await recordingResponse(
        source([summary([4, 4])]),
        new Request("https://x/r.wav", { headers: { Range: "bytes=45-49" } }),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 45-49/52");
      expect([...(await collect(response))]).toEqual([1, 1, 1, 2, 2]);
    });

    it("serves a span that lies entirely inside the header", async () => {
      const response = await recordingResponse(
        source([summary([4, 4])]),
        new Request("https://x/r.wav", { headers: { Range: "bytes=0-3" } }),
      );
      expect(String.fromCharCode(...(await collect(response)))).toBe("RIFF");
    });

    it("refuses a span past the end of the recording", async () => {
      const response = await recordingResponse(
        source([summary([4, 4])]),
        new Request("https://x/r.wav", { headers: { Range: "bytes=999-" } }),
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */52");
    });

    it("ignores a range on a recording that is still running", async () => {
      const response = await recordingResponse(
        source([summary([4], true)]),
        new Request("https://x/r.wav", { headers: { Range: "bytes=45-" } }),
      );
      expect(response.status).toBe(206);
    });
  });
});
