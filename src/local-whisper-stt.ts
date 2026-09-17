/**
 * Copied from the `local-whisper-stt` branch of the agents fork
 * (examples/voice-input/src/local-whisper-stt.ts).
 *
 * Local, low-quality STT provider for offline development.
 *
 * Talks to a whisperfile server (https://huggingface.co/Mozilla/whisperfile)
 * running on your machine instead of Cloudflare's Workers AI binding. No
 * Cloudflare account or network access required.
 *
 * Setup:
 *   1. `pnpm stt:setup` — downloads whisper-tiny.en.llamafile into
 *      .whisperfile/ (gitignored; not checked in, ~90MB).
 *   2. `pnpm stt:server` — starts it on port 8080.
 *   3. Set `STT_PROVIDER=whisper-local` in `.dev.vars` (see src/stt.ts).
 *
 * Unlike Nova 3, whisperfile has no streaming/endpointing — this session
 * does its own naive energy-based VAD to chunk mic audio into utterances
 * before sending each one to the server. Quality and latency are both
 * noticeably worse than the hosted model; that's expected for this use case.
 */

import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "agents/voice";

export interface LocalWhisperfileSTTOptions {
  /** whisper.cpp server inference endpoint. @default "http://localhost:8080/inference" */
  url?: string;
  /** Sample rate in Hz of the incoming PCM audio. @default 16000 */
  sampleRate?: number;
  /** Silence duration (ms) after speech that ends an utterance. @default 800 */
  silenceMs?: number;
  /** Utterances shorter than this are dropped as noise. @default 300 */
  minUtteranceMs?: number;
  /** RMS energy (0-1) above which audio is considered speech. @default 0.02 */
  energyThreshold?: number;
}

const DEFAULTS: Required<LocalWhisperfileSTTOptions> = {
  url: "http://localhost:8080/inference",
  sampleRate: 16000,
  silenceMs: 800,
  minUtteranceMs: 300,
  energyThreshold: 0.02
};

/**
 * STT provider backed by a local whisperfile server. Drop-in replacement
 * for `WorkersAINova3STT` for offline / no-Cloudflare-account development.
 */
export class LocalWhisperfileSTT implements Transcriber {
  #opts: Required<LocalWhisperfileSTTOptions>;

  constructor(options?: LocalWhisperfileSTTOptions) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new LocalWhisperSession(this.#opts, options);
  }
}

class LocalWhisperSession implements TranscriberSession {
  #onUtterance: TranscriberSessionOptions["onUtterance"];
  #onFatalError: TranscriberSessionOptions["onFatalError"];

  #opts: Required<LocalWhisperfileSTTOptions>;
  #closed = false;

  #buffer: Int16Array[] = [];
  #hasSpeech = false;
  #silenceSamples = 0;

  constructor(
    opts: Required<LocalWhisperfileSTTOptions>,
    options?: TranscriberSessionOptions
  ) {
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
      this.#hasSpeech = true;
      this.#silenceSamples = 0;
    } else {
      this.#silenceSamples += samples.length;
    }
    this.#buffer.push(samples);

    const silenceMs = (this.#silenceSamples / this.#opts.sampleRate) * 1000;
    if (this.#hasSpeech && silenceMs >= this.#opts.silenceMs) {
      this.#flush();
    }
  }

  close(): void {
    this.#closed = true;
    this.#buffer = [];
  }

  #flush(): void {
    const chunks = this.#buffer;
    const hadSpeech = this.#hasSpeech;
    this.#buffer = [];
    this.#hasSpeech = false;
    this.#silenceSamples = 0;

    if (!hadSpeech) return;

    const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
    const durationMs = (totalSamples / this.#opts.sampleRate) * 1000;
    if (durationMs < this.#opts.minUtteranceMs) return;

    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    this.#transcribe(merged).catch((error) => {
      if (this.#closed) return;
      this.#onFatalError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  async #transcribe(samples: Int16Array): Promise<void> {
    const wav = encodeWav(samples, this.#opts.sampleRate);

    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");

    const resp = await fetch(this.#opts.url, { method: "POST", body: form });
    if (!resp.ok) {
      throw new Error(`Local whisper server responded ${resp.status}`);
    }

    const data = (await resp.json()) as { text?: string };
    const text = (data.text ?? "").trim();
    if (text && !this.#closed) {
      this.#onUtterance?.(text);
    }
  }
}

/** Wraps raw 16-bit PCM samples in a minimal WAV (RIFF) container. */
function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
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
