import { describe, expect, it, vi } from "vitest";
import { VadTranscriber } from "./vad-transcriber";
import type { WavTranscribe } from "./vad-transcriber";

const SAMPLE_RATE = 16000;

/** `ms` of 16kHz mono PCM at one amplitude, as the pipeline feeds it. */
function pcm(ms: number, amplitude: number): ArrayBuffer {
  const samples = new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE));
  samples.fill(amplitude);
  return samples.buffer;
}

/** Loud enough to clear the 0.02 RMS threshold (0.02 * 32768 ≈ 655). */
const speech = (ms: number) => pcm(ms, 8000);
const silence = (ms: number) => pcm(ms, 0);

/**
 * A transcriber plus the hooks a test needs: what the session was handed, and
 * manual control over when each transcription resolves.
 */
function setup(options?: { transcribe?: WavTranscribe }) {
  const wavs: ArrayBuffer[] = [];
  const transcribe = vi.fn<WavTranscribe>(
    options?.transcribe ??
      ((wav) => {
        wavs.push(wav);
        return Promise.resolve("heard something");
      }),
  );
  const onUtterance = vi.fn<(text: string) => void>();
  const onFatalError = vi.fn<(error: Error) => void>();
  const session = new VadTranscriber(transcribe).createSession({ onUtterance, onFatalError });
  return { transcribe, wavs, onUtterance, onFatalError, session };
}

/** Let the flush's floating promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("VadTranscriber", () => {
  it("never transcribes a call that was silent throughout", async () => {
    const { transcribe, session } = setup();
    session.feed(silence(2000));
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("transcribes once when speech is followed by the silence gap", async () => {
    const { transcribe, onUtterance, session } = setup();
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onUtterance).toHaveBeenCalledWith("heard something");
  });

  // Once an utterance has flushed, the trailing silence must not flush again —
  // a long pause after a sentence would otherwise fire on every chunk.
  it("does not transcribe again while the silence continues", async () => {
    const { transcribe, session } = setup();
    session.feed(speech(500));
    session.feed(silence(800));
    session.feed(silence(2000));
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  // A door slam or a chair scrape clears the energy threshold but is not
  // speech; sending it to the model costs an inference call for nothing.
  it("drops a burst shorter than the minimum utterance", async () => {
    const { transcribe, session } = setup();
    session.feed(speech(100));
    session.feed(silence(800));
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("hands over a mono 16-bit WAV at the configured sample rate", async () => {
    const { wavs, session } = setup();
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();

    const view = new DataView(wavs[0]);
    const tag = (offset: number) => String.fromCharCode(...new Uint8Array(wavs[0], offset, 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // The whole buffer ships, trailing silence included: 500ms of speech plus
    // the 800ms gap, at two bytes a sample, after a 44-byte header.
    expect(view.byteLength).toBe(44 + (1300 / 1000) * SAMPLE_RATE * 2);
  });

  it("trims the transcript before emitting it", async () => {
    const { onUtterance, session } = setup({
      transcribe: () => Promise.resolve("  hello there \n"),
    });
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();
    expect(onUtterance).toHaveBeenCalledWith("hello there");
  });

  it("emits nothing when the model heard no words", async () => {
    const { onUtterance, session } = setup({ transcribe: () => Promise.resolve("   ") });
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it("reports a failing transport as fatal", async () => {
    const { onFatalError, session } = setup({
      transcribe: () => Promise.reject(new Error("server responded 503")),
    });
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError.mock.calls[0][0].message).toBe("server responded 503");
  });

  // Hang-up closes the session while a transcription is still in flight. Its
  // late result belongs to a call that no longer exists.
  it("stays quiet when a transcription lands after close", async () => {
    let resolve!: (text: string) => void;
    const { onUtterance, onFatalError, session } = setup({
      transcribe: () => new Promise<string>((r) => (resolve = r)),
    });
    session.feed(speech(500));
    session.feed(silence(800));
    session.close();
    resolve("too late");
    await settle();
    expect(onUtterance).not.toHaveBeenCalled();
    expect(onFatalError).not.toHaveBeenCalled();
  });

  // Muting stops the audio stream outright, so the silence this VAD endpoints
  // on never arrives and the sentence in progress would be stranded.
  it("emits the utterance in progress when asked to flush", async () => {
    const { transcribe, onUtterance, session } = setup();
    session.feed(speech(500));
    session.flush?.();
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onUtterance).toHaveBeenCalledWith("heard something");
  });

  it("does not transcribe a flush that caught only silence", async () => {
    const { transcribe, session } = setup();
    session.feed(silence(2000));
    session.flush?.();
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
  });

  // The flush consumed the buffer, so unmuting mid-pause must not resend it.
  it("starts clean after a flush", async () => {
    const { transcribe, wavs, session } = setup();
    session.feed(speech(500));
    session.flush?.();
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(wavs[1].byteLength).toBe(44 + (1300 / 1000) * SAMPLE_RATE * 2);
  });

  it("ignores a flush after close", async () => {
    const { transcribe, session } = setup();
    session.feed(speech(500));
    session.close();
    session.flush?.();
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("ignores audio fed after close", async () => {
    const { transcribe, session } = setup();
    session.close();
    session.feed(speech(500));
    session.feed(silence(800));
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
