/**
 * Whisper on this machine, through a whisperfile server.
 *
 * The same model as `cloudflare-whisper.ts` — which is why the two specs
 * differ only in their host, `@local/openai/whisper-tiny-en` against
 * `@cf/openai/whisper-tiny-en` — but run locally, so a demo works with no
 * Cloudflare account and no network at all.
 *
 * Setup:
 *   1. `pnpm stt:setup` — downloads whisper-tiny.en.llamafile into
 *      .whisperfile/ (gitignored; not checked in, ~90MB).
 *   2. `pnpm stt:server` — starts it on port 8080.
 *   3. Set `STT_MODEL=@local/openai/whisper-tiny-en` in `.dev.vars`.
 *
 * Originally copied from the `local-whisper-stt` branch of the agents fork
 * (examples/voice-input/src/local-whisper-stt.ts); its VAD half has since
 * moved to `vad-transcriber.ts`, shared with the Workers AI transport.
 */

import type { Transcriber } from "agents/voice";
import { VadTranscriber } from "./vad-transcriber";
import type { VadOptions } from "./vad-transcriber";

export interface LocalWhisperOptions extends VadOptions {
  /** whisper.cpp server inference endpoint. @default "http://localhost:8080/inference" */
  url?: string;
}

const DEFAULT_URL = "http://localhost:8080/inference";

export function localWhisper(options?: LocalWhisperOptions): Transcriber {
  const url = options?.url || DEFAULT_URL;

  return new VadTranscriber(async (wav) => {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");

    const resp = await fetch(url, { method: "POST", body: form });
    if (!resp.ok) {
      throw new Error(`Local whisper server responded ${resp.status}`);
    }

    const data = (await resp.json()) as { text?: string };
    return data.text ?? "";
  }, options);
}
