import { WorkersAIFluxSTT, WorkersAINova3STT } from "agents/voice";
import type { Transcriber } from "agents/voice";
import { parseModelSpec } from "../model-spec";
import { cloudflareWhisper } from "./cloudflare-whisper";
import { localWhisper } from "./local-whisper";
import { CallTranscriber } from "./call-transcriber";

/**
 * Speech-to-text selection, by `STT_MODEL` — one `@host/model` spec, the same
 * grammar `TEXT_MODEL` uses (see `../model-spec.ts`):
 *
 * - `@cf/openai/whisper-tiny-en` (default) — Workers AI whisper. Cheapest, and
 *   the only hosted option that does not open a WebSocket, so it survives the
 *   local dev proxy. Batch, so no interim text: an utterance lands after
 *   ~800ms of silence.
 * - `@cf/deepgram/nova-3` — best quality, streams interim text. Opens a
 *   WebSocket through the AI binding, which needs `"remote": true` in
 *   `wrangler.jsonc`; the local dev proxy cannot perform the upgrade and the
 *   session dies with "did not return a WebSocket".
 * - `@cf/deepgram/flux` — same WebSocket path as Nova 3, same caveat.
 * - `@local/openai/whisper-tiny-en` — the same whisper model on this machine
 *   (`pnpm stt:setup`, then `pnpm stt:server`). Offline, no Cloudflare calls.
 *   Override its endpoint with `STT_WHISPER_URL`.
 *
 * Unlike `TEXT_MODEL`, this is a fixed menu rather than a pass-through: each
 * entry needs its own client, so a Workers AI id that is merely unwired has to
 * fail loudly rather than look like a typo.
 */
const DEFAULT_STT_MODEL = "@cf/openai/whisper-tiny-en";

const SUPPORTED = [
  "@cf/openai/whisper-tiny-en",
  "@cf/deepgram/nova-3",
  "@cf/deepgram/flux",
  "@local/openai/whisper-tiny-en",
] as const;

/** The bare provider for one spec, before the per-call wrapper goes on. */
export function selectTranscriber(env: Env, spec: string): Transcriber {
  // Parses first, so a malformed spec is named as such rather than being
  // reported as an unsupported model.
  parseModelSpec(spec, "STT_MODEL");

  switch (spec) {
    case "@cf/openai/whisper-tiny-en":
      return cloudflareWhisper(env.AI, spec);
    case "@cf/deepgram/nova-3":
      return new WorkersAINova3STT(env.AI);
    case "@cf/deepgram/flux":
      return new WorkersAIFluxSTT(env.AI);
    case "@local/openai/whisper-tiny-en":
      return localWhisper(env.STT_WHISPER_URL ? { url: String(env.STT_WHISPER_URL) } : undefined);
    default:
      throw new Error(
        `STT_MODEL=${spec} is not one of the supported models:\n  ${SUPPORTED.join("\n  ")}`,
      );
  }
}

export function getTranscriber(env: Env): CallTranscriber {
  const spec = sttLabel(env);
  console.log(`[stt] model = ${spec}`);
  return new CallTranscriber(selectTranscriber(env, spec), spec);
}

/** Which transcriber is in use — shown in the host header next to the model. */
export function sttLabel(env: Env): string {
  return String(env.STT_MODEL || DEFAULT_STT_MODEL);
}
