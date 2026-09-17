import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";

/**
 * Model selection, lifted from `examples/playground/src/model.ts` (its TTS
 * half is dropped — this prototype transcribes speech but never speaks).
 *
 * `MODEL_PROVIDER` picks the provider, like `STT_PROVIDER` does for speech:
 *   workers-ai  Workers AI through the AI binding. No keys needed. Default.
 *   openrouter  OpenRouter, using OPENROUTER_API_KEY and OPENROUTER_MODEL.
 * The free OpenRouter tier caps requests per day; switch back to workers-ai
 * when it runs out.
 */
const DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.7-code";
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

function provider(env: Env): "workers-ai" | "openrouter" {
  const name = String(env.MODEL_PROVIDER ?? "workers-ai");
  if (name !== "workers-ai" && name !== "openrouter") {
    throw new Error(`Unknown MODEL_PROVIDER "${name}"`);
  }
  if (name === "openrouter" && !env.OPENROUTER_API_KEY) {
    throw new Error("MODEL_PROVIDER=openrouter needs OPENROUTER_API_KEY");
  }
  return name;
}

/** Kimi K2 needs a paid Workers plan; set WORKERS_AI_MODEL to try others. */
function workersAIModel(env: Env): string {
  return String(env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL);
}

function openRouterModel(env: Env): string {
  return String(env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL);
}

export function getModel(env: Env, options?: { sessionAffinity?: string }): LanguageModel {
  if (provider(env) === "openrouter") {
    const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
    return openrouter(openRouterModel(env));
  }

  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(workersAIModel(env), {
    sessionAffinity: options?.sessionAffinity,
  });
}

/** Which provider a turn will actually use — surfaced so the demo can say so. */
export function modelLabel(env: Env): string {
  return provider(env) === "openrouter"
    ? `OpenRouter (${openRouterModel(env)})`
    : `Workers AI (${workersAIModel(env)})`;
}
