import { WorkersAIFluxSTT, WorkersAINova3STT } from "agents/voice";
import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";
import { LocalWhisperfileSTT } from "./local-whisper-stt";

/**
 * Speech-to-text selection, by `STT_PROVIDER` (set in `.dev.vars`):
 *
 * - `nova3` (default) — Workers AI Deepgram Nova 3. Best quality, streams
 *   interim text. Opens a WebSocket through the AI binding, which under
 *   `vite dev` is a remote proxy; that path has failed mid-session locally.
 * - `flux` — Workers AI Deepgram Flux. Same WebSocket path as Nova 3, so the
 *   same local caveat applies.
 * - `whisper-local` — a whisperfile server on this machine (`pnpm stt:setup`,
 *   then `pnpm stt:server`). Offline and no Cloudflare calls, but lower
 *   quality, no interim text, and an utterance only lands after ~800ms of
 *   silence. Override its endpoint with `STT_WHISPER_URL`.
 */
/**
 * Wraps a transcriber so a call's whole audio path prints to the dev server
 * terminal. This sits exactly on the boundary between "audio reached the
 * Worker" and "text came back", which is what tells the three failure modes
 * apart: no `feed` lines at all means the browser never sent audio; `feed`
 * lines with no `interim`/`FINAL` means the provider is deaf or dead; a
 * `FATAL`/`failed to start` line names a broken provider outright.
 */
function withLogging(inner: Transcriber, provider: string): Transcriber {
  return {
    createSession(options?: TranscriberSessionOptions): TranscriberSession {
      let chunks = 0;
      let bytes = 0;
      let interims = 0;
      let finals = 0;
      console.log(`[stt] ${provider}: opening session`);

      const session = inner.createSession({
        ...options,
        onInterim: (text) => {
          interims += 1;
          // Interims fire many times a second; a sample is enough to prove life.
          if (interims === 1 || interims % 10 === 0) {
            console.log(`[stt] interim #${interims}: ${JSON.stringify(text.slice(-60))}`);
          }
          options?.onInterim?.(text);
        },
        onSpeechStart: (text) => {
          console.log("[stt] speech started");
          options?.onSpeechStart?.(text);
        },
        onUtterance: (transcript) => {
          finals += 1;
          console.log(`[stt] FINAL #${finals}: ${JSON.stringify(transcript)}`);
          options?.onUtterance?.(transcript);
        },
        onFatalError: (error) => {
          console.error(`[stt] FATAL: ${error.message}`);
          options?.onFatalError?.(error);
        },
      });

      const wrapped: TranscriberSession = {
        feed(chunk) {
          chunks += 1;
          bytes += chunk.byteLength;
          if (chunks === 1) console.log(`[stt] first audio chunk (${chunk.byteLength} bytes)`);
          else if (chunks % 50 === 0) {
            console.log(`[stt] audio: ${chunks} chunks, ${(bytes / 1024).toFixed(0)}KB`);
          }
          session.feed(chunk);
        },
        close() {
          console.log(
            `[stt] session closed — ${chunks} chunks, ${interims} interim, ${finals} final`,
          );
          session.close();
        },
      };

      if (session.waitUntilReady) {
        wrapped.waitUntilReady = async () => {
          try {
            await session.waitUntilReady?.();
            console.log(`[stt] ${provider}: session READY, accepting audio`);
          } catch (error) {
            console.error(`[stt] ${provider}: session FAILED to start —`, error);
            throw error;
          }
        };
      }
      if (session.updateAgentContext) {
        wrapped.updateAgentContext = (text) => session.updateAgentContext?.(text);
      }
      return wrapped;
    },
  };
}

export function getTranscriber(env: Env): Transcriber {
  const provider = String(env.STT_PROVIDER ?? "nova3");
  console.log(`[stt] provider = ${provider}`);
  switch (provider) {
    case "whisper-local":
      return withLogging(
        new LocalWhisperfileSTT(
          env.STT_WHISPER_URL ? { url: String(env.STT_WHISPER_URL) } : undefined,
        ),
        provider,
      );
    case "flux":
      return withLogging(new WorkersAIFluxSTT(env.AI), provider);
    case "nova3":
      return withLogging(new WorkersAINova3STT(env.AI), provider);
    default:
      throw new Error(`Unknown STT_PROVIDER "${provider}"; use nova3, flux, or whisper-local`);
  }
}

/** Which transcriber is in use — shown in the host header next to the model. */
export function sttLabel(env: Env): string {
  return String(env.STT_PROVIDER ?? "nova3");
}
