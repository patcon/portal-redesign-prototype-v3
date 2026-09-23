import { WorkersAIFluxSTT, WorkersAINova3STT } from "agents/voice";
import type { Transcriber } from "agents/voice";
import { LocalWhisperfileSTT } from "./local-whisper-stt";
import { CallTranscriber, type CallTranscriberOptions } from "./call-transcriber";

/**
 * Speech-to-text selection, by `STT_PROVIDER` (set in `.dev.vars`):
 *
 * - `nova3` (default) — Workers AI Deepgram Nova 3. Best quality, streams
 *   interim text. Opens a WebSocket through the AI binding, which needs
 *   `"remote": true` in `wrangler.jsonc`: the local dev proxy cannot perform
 *   the upgrade, and the session dies with "did not return a WebSocket".
 * - `flux` — Workers AI Deepgram Flux. Same WebSocket path as Nova 3, so the
 *   same binding caveat applies.
 * - `whisper-local` — a whisperfile server on this machine (`pnpm stt:setup`,
 *   then `pnpm stt:server`). Offline and no Cloudflare calls, but lower
 *   quality, no interim text, and an utterance only lands after ~800ms of
 *   silence. Override its endpoint with `STT_WHISPER_URL`.
 */
function selectProvider(env: Env, provider: string): Transcriber {
  switch (provider) {
    case "whisper-local":
      return new LocalWhisperfileSTT(
        env.STT_WHISPER_URL ? { url: String(env.STT_WHISPER_URL) } : undefined,
      );
    case "flux":
      return new WorkersAIFluxSTT(env.AI);
    case "nova3":
      return new WorkersAINova3STT(env.AI);
    default:
      throw new Error(`Unknown STT_PROVIDER "${provider}"; use nova3, flux, or whisper-local`);
  }
}

export function getTranscriber(env: Env, options?: CallTranscriberOptions): CallTranscriber {
  const provider = String(env.STT_PROVIDER ?? "nova3");
  console.log(`[stt] provider = ${provider}`);
  return new CallTranscriber(selectProvider(env, provider), provider, options);
}

/** Which transcriber is in use — shown in the host header next to the model. */
export function sttLabel(env: Env): string {
  return String(env.STT_PROVIDER ?? "nova3");
}
