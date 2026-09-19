/**
 * A `Transcriber` for batch speech-to-text models, which is to say: everything
 * that is not Deepgram.
 *
 * `agents/voice` ships only streaming transcribers, because its `Transcriber`
 * contract assumes the provider detects utterance boundaries itself (Flux
 * `EndOfTurn`, Nova 3 `speech_final`). Whisper has no endpointing and no
 * interim results — it takes a clip and returns text — so the caller has to
 * chunk the mic stream into utterances before it can use one at all.
 *
 * That chunking is what this class is: a naive energy-based VAD that buffers
 * audio, notices a pause, wraps what it heard in a WAV, and hands it to
 * whatever transport it was constructed with. Quality and latency are both
 * worse than a streaming model — there is no text until you stop talking —
 * which is the trade every whisper-backed option here makes.
 *
 * The transport is a callback rather than a subclass hook because the two
 * implementations differ only in that one function: `local-whisper.ts` POSTs
 * to a whisperfile server, `cloudflare-whisper.ts` calls the AI binding.
 */

import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";

/** Turns one WAV clip into text. Rejecting is fatal to the session. */
export type WavTranscribe = (wav: ArrayBuffer) => Promise<string>;

export interface VadOptions {
  /** Sample rate in Hz of the incoming PCM audio. @default 16000 */
  sampleRate?: number;
  /** Silence duration (ms) after speech that ends an utterance. @default 800 */
  silenceMs?: number;
  /** Speech shorter than this is dropped as noise. @default 300 */
  minUtteranceMs?: number;
  /** RMS energy (0-1) above which audio is considered speech. @default 0.02 */
  energyThreshold?: number;
}

const DEFAULTS: Required<VadOptions> = {
  sampleRate: 16000,
  silenceMs: 800,
  minUtteranceMs: 300,
  energyThreshold: 0.02,
};

export class VadTranscriber implements Transcriber {
  #transcribe: WavTranscribe;
  #opts: Required<VadOptions>;

  constructor(transcribe: WavTranscribe, options?: VadOptions) {
    this.#transcribe = transcribe;
    this.#opts = { ...DEFAULTS, ...options };
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new VadSession(this.#transcribe, this.#opts, options);
  }
}

class VadSession implements TranscriberSession {
  #transcribe: WavTranscribe;
  #onUtterance: TranscriberSessionOptions["onUtterance"];
  #onFatalError: TranscriberSessionOptions["onFatalError"];

  #opts: Required<VadOptions>;
  #closed = false;

  #buffer: Int16Array[] = [];
  /** Samples in the buffer that cleared the energy threshold. */
  #speechSamples = 0;
  #silenceSamples = 0;

  constructor(
    transcribe: WavTranscribe,
    opts: Required<VadOptions>,
    options?: TranscriberSessionOptions,
  ) {
    this.#transcribe = transcribe;
    this.#opts = opts;
    this.#onUtterance = options?.onUtterance;
    this.#onFatalError = options?.onFatalError;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;

    const samples = new Int16Array(chunk);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    if (rms > this.#opts.energyThreshold) {
      this.#speechSamples += samples.length;
      this.#silenceSamples = 0;
    } else {
      this.#silenceSamples += samples.length;
    }
    this.#buffer.push(samples);

    const silenceMs = (this.#silenceSamples / this.#opts.sampleRate) * 1000;
    if (this.#speechSamples > 0 && silenceMs >= this.#opts.silenceMs) {
      this.#flush();
    }
  }

  /**
   * Emit the buffered utterance now instead of waiting for the silence gap.
   *
   * Called when the client mutes: the audio stream stops outright, so the
   * 800ms of silence this VAD endpoints on would never arrive and a
   * half-finished sentence would sit here until the microphone came back.
   * Buffered silence with no speech in it is simply discarded.
   */
  flush(): void {
    if (this.#closed) return;
    this.#flush();
  }

  close(): void {
    this.#closed = true;
    this.#buffer = [];
  }

  #flush(): void {
    const chunks = this.#buffer;
    const speechSamples = this.#speechSamples;
    this.#buffer = [];
    this.#speechSamples = 0;
    this.#silenceSamples = 0;

    // Measured over the speech, not the whole buffer: the buffer always holds
    // the full silence gap that triggered this flush, so counting it would
    // make the threshold unreachable and let every stray noise through.
    const speechMs = (speechSamples / this.#opts.sampleRate) * 1000;

    const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
    // The buffer holds everything since the last flush, leading silence
    // included, so a long pause makes the next clip enormous. Logged because
    // that is the thing to watch when transcription stops after a pause.
    console.log(
      `[vad] flush: ${Math.round(speechMs)}ms speech in ${Math.round(
        (totalSamples / this.#opts.sampleRate) * 1000,
      )}ms clip (${Math.round((totalSamples * 2 + 44) / 1024)}KB)${
        speechMs < this.#opts.minUtteranceMs ? " — dropped, under minUtteranceMs" : ""
      }`,
    );
    if (speechMs < this.#opts.minUtteranceMs) return;

    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    this.#emit(merged).catch((error) => {
      if (this.#closed) return;
      this.#onFatalError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async #emit(samples: Int16Array): Promise<void> {
    const text = (await this.#transcribe(encodeWav(samples, this.#opts.sampleRate))).trim();
    if (text && !this.#closed) {
      this.#onUtterance?.(text);
    }
  }
}

/** Wraps raw 16-bit PCM samples in a minimal WAV (RIFF) container. */
export function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }

  return buffer;
}
