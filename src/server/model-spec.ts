/**
 * The one config grammar this prototype uses to name a model: `@host/model`.
 *
 * The prefix says *where* it runs, the rest says *which* model — so a Workers
 * AI catalog id like `@cf/openai/whisper-tiny-en` is already a valid spec, and
 * its offline twin is the same string with the host swapped:
 *
 *   TEXT_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
 *   TEXT_MODEL=@openrouter/anthropic/claude-haiku-4.5
 *   STT_MODEL=@cf/openai/whisper-tiny-en
 *   STT_MODEL=@local/openai/whisper-tiny-en
 *
 * One variable per *task* (text, speech-to-text, and TTS when it returns),
 * which is how Cloudflare's own catalog is organised.
 */

export interface ModelSpec {
  /** Where the model runs: `cf`, `openrouter`, `local`. */
  host: string;
  /**
   * Everything after the host, vendor segment included — OpenRouter ids carry
   * their own slash (`anthropic/claude-haiku-4.5`), so only the first one
   * separates the two halves.
   */
  model: string;
}

/** Splits `@host/model`. `varName` names the env var, so errors say what to fix. */
export function parseModelSpec(spec: string, varName: string): ModelSpec {
  const match = /^@([^/]+)\/(.+)$/.exec(spec);
  if (!match) {
    throw new Error(`${varName}="${spec}" is malformed; expected @host/model`);
  }
  return { host: match[1], model: match[2] };
}
