import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";

/**
 * Model selection, lifted from `examples/playground/src/model.ts` (its TTS
 * half is dropped — this prototype transcribes speech but never speaks).
 *
 * Workers AI by default, so the prototype runs with no keys at all. Set
 * OPENROUTER_API_KEY in `.dev.vars` to route through OpenRouter instead.
 */
const WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.7-code";
const OPENROUTER_MODEL = "openrouter/free";

export function getModel(
  env: Env,
  options?: { sessionAffinity?: string }
): LanguageModel {
  // Declared in wrangler.jsonc's secrets.required, but may be unset locally.
  if (env.OPENROUTER_API_KEY) {
    const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
    return openrouter(OPENROUTER_MODEL);
  }

  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(WORKERS_AI_MODEL, {
    sessionAffinity: options?.sessionAffinity
  });
}

/** Which provider a turn will actually use — surfaced so the demo can say so. */
export function modelLabel(env: Env): string {
  return env.OPENROUTER_API_KEY
    ? `OpenRouter (${OPENROUTER_MODEL})`
    : `Workers AI (${WORKERS_AI_MODEL})`;
}
