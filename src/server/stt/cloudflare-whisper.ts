/**
 * Whisper on Workers AI, through the `AI` binding.
 *
 * The cheapest speech-to-text Cloudflare offers, and the only one here that
 * does not open a WebSocket: Nova 3 and Flux upgrade a connection through the
 * binding, which is why `wrangler.jsonc` pins `"remote": true` and why they
 * can still die mid-session with "did not return a WebSocket". This one is a
 * plain request/response `ai.run`, so it works under the local dev proxy.
 *
 * What it costs is liveness. Whisper transcribes a finished clip, so there are
 * no interim results and nothing appears until {@link VadTranscriber} hears a
 * pause. Same model as `local-whisper.ts` runs offline — the two differ only
 * in where the clip is sent.
 */

import type { Transcriber } from "agents/voice";
import { VadTranscriber } from "./vad-transcriber";
import type { VadOptions } from "./vad-transcriber";

/** Workers AI whisper model ids, which double as their `STT_MODEL` spec. */
type WhisperModel = "@cf/openai/whisper-tiny-en";

export function cloudflareWhisper(ai: Ai, model: WhisperModel, options?: VadOptions): Transcriber {
  return new VadTranscriber(async (wav) => {
    // The binding wants the clip as 8-bit unsigned values; an ArrayBuffer or a
    // typed array is rejected.
    const result = await ai.run(model, { audio: Array.from(new Uint8Array(wav)) });
    return result.text ?? "";
  }, options);
}
