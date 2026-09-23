import { describe, expect, it } from "vitest";
import {
  BYTES_PER_SAMPLE,
  STREAMING_SIZE,
  durationSeconds,
  peakOf,
  resumeTone,
  SAMPLE_RATE,
  wavHeader,
} from "./wav";

/** The four-character tag at `offset`, as WAV spells its chunk names. */
function tag(header: Uint8Array, offset: number): string {
  return String.fromCharCode(...header.subarray(offset, offset + 4));
}

function u32(header: Uint8Array, offset: number): number {
  return new DataView(header.buffer, header.byteOffset).getUint32(offset, true);
}

function u16(header: Uint8Array, offset: number): number {
  return new DataView(header.buffer, header.byteOffset).getUint16(offset, true);
}

describe("wavHeader", () => {
  it("is the 44 bytes of a canonical RIFF/WAVE header", () => {
    const header = wavHeader(1000);
    expect(header).toHaveLength(44);
    expect(tag(header, 0)).toBe("RIFF");
    expect(tag(header, 8)).toBe("WAVE");
    expect(tag(header, 12)).toBe("fmt ");
    expect(tag(header, 36)).toBe("data");
  });

  it("declares 16-bit mono PCM at the rate the voice client sends", () => {
    const header = wavHeader(1000);
    expect(u32(header, 16)).toBe(16); // fmt chunk size
    expect(u16(header, 20)).toBe(1); // format: PCM
    expect(u16(header, 22)).toBe(1); // mono
    expect(u32(header, 24)).toBe(SAMPLE_RATE);
    expect(u32(header, 28)).toBe(SAMPLE_RATE * 2); // byte rate
    expect(u16(header, 32)).toBe(2); // block align
    expect(u16(header, 34)).toBe(16); // bits per sample
  });

  it("sizes both length fields from the data it is given", () => {
    const header = wavHeader(1000);
    expect(u32(header, 40)).toBe(1000); // data chunk
    expect(u32(header, 4)).toBe(1036); // RIFF chunk: 36 + data
  });

  it("writes the streaming placeholder for a recording still in progress", () => {
    const header = wavHeader(STREAMING_SIZE);
    expect(u32(header, 40)).toBe(STREAMING_SIZE);
    // 36 + 0xffffffff must not be written truncated or as 35.
    expect(u32(header, 4)).toBe(STREAMING_SIZE);
  });
});

describe("durationSeconds", () => {
  it("reads one second out of one second of 16kHz mono 16-bit audio", () => {
    expect(durationSeconds(SAMPLE_RATE * 2)).toBe(1);
  });

  it("is zero for a recording with nothing in it", () => {
    expect(durationSeconds(0)).toBe(0);
  });
});

describe("peakOf", () => {
  it("reads 1 from a full-scale sample", () => {
    const pcm = new Int16Array([0, 32767, -12000]);
    expect(peakOf(new Uint8Array(pcm.buffer))).toBeCloseTo(1, 4);
  });

  it("reads 0 from silence", () => {
    expect(peakOf(new Uint8Array(new Int16Array(64).buffer))).toBe(0);
  });

  it("finds the peak in the negative direction too", () => {
    const pcm = new Int16Array([0, 100, -32768]);
    expect(peakOf(new Uint8Array(pcm.buffer))).toBeCloseTo(1, 4);
  });

  it("is zero for an empty buffer rather than -Infinity", () => {
    expect(peakOf(new Uint8Array(0))).toBe(0);
  });
});

describe("resumeTone", () => {
  /** The tone's samples, read back the way the recording stores them. */
  function samples(): Int16Array {
    const tone = resumeTone();
    return new Int16Array(tone.buffer, tone.byteOffset, tone.byteLength / BYTES_PER_SAMPLE);
  }

  it("is short enough to mark a gap rather than fill it", () => {
    expect(durationSeconds(resumeTone().byteLength)).toBeLessThan(0.3);
  });

  it("is a whole number of samples, so it cannot shear the stream", () => {
    expect(resumeTone().byteLength % BYTES_PER_SAMPLE).toBe(0);
  });

  it("carries over the room without being an alert", () => {
    const peak = peakOf(resumeTone());
    // Loud enough to hear against speech played back at the same level, and
    // still well under a raised voice.
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.4);
  });

  it("starts and ends at silence, so it splices in without a click", () => {
    const pcm = samples();
    expect(pcm[0]).toBe(0);
    expect(pcm[pcm.length - 1]).toBe(0);
  });

  it("is two pops with silence between them", () => {
    const pcm = samples();
    const third = pcm.length / 3;
    const run = (from: number, to: number) =>
      peakOf(new Uint8Array(pcm.buffer, from * BYTES_PER_SAMPLE, (to - from) * BYTES_PER_SAMPLE));

    // Two marks rather than one: a single tone in a recording of a room is
    // something that might have been in the room. A pair is plainly put there.
    expect(run(0, third)).toBeGreaterThan(0);
    expect(run(third, third * 2)).toBe(0);
    expect(run(third * 2, pcm.length)).toBeGreaterThan(0);
  });

  it("is the same bytes every time, so it can be built once", () => {
    expect(resumeTone()).toBe(resumeTone());
  });
});
