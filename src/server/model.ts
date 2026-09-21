import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import { wrapLanguageModel } from "ai";
import { parseModelSpec } from "./model-spec";
import { logModelCalls } from "./model-logging";

/**
 * The chat model, named by `TEXT_MODEL` as a single `@host/model` spec (see
 * `model-spec.ts`). Lifted from `examples/playground/src/model.ts` — its TTS
 * half is dropped, since this prototype transcribes speech but never speaks.
 *
 *   TEXT_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast   any Workers AI model
 *   TEXT_MODEL=@openrouter/anthropic/claude-haiku-4.5     needs OPENROUTER_API_KEY
 *
 * Nothing here enumerates models: whatever follows the host goes straight to
 * the provider, so any id from either catalog works without a code change.
 *
 * The default is Llama rather than anything larger so that a fresh clone runs
 * with no keys *and* no paid Workers plan — `@cf/moonshotai/kimi-k2.7-code` is
 * the better model but fails with "5035: not available on the Workers Free
 * plan". OpenRouter's free tier caps requests per day; when it runs out, put
 * an `@cf/...` spec back.
 */
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function textSpec(env: Env): string {
  return String(env.TEXT_MODEL || DEFAULT_TEXT_MODEL);
}

export function getModel(env: Env, options?: { sessionAffinity?: string }): LanguageModel {
  const spec = textSpec(env);
  // Every model goes out through the same tap, so a silent turn leaves a trail
  // in the dev console whichever host answered it. See `model-logging.ts`.
  return wrapLanguageModel({
    model: rawModel(env, spec, options),
    middleware: logModelCalls(spec),
  });
}

/** `LanguageModel` also admits a bare id string; the wrapper needs the object. */
function rawModel(
  env: Env,
  spec: string,
  options?: { sessionAffinity?: string },
): Exclude<LanguageModel, string> {
  const { host, model } = parseModelSpec(spec, "TEXT_MODEL");

  switch (host) {
    case "cf": {
      // A Workers AI id *is* the spec, prefix included — pass it through whole.
      const workersai = createWorkersAI({ binding: env.AI });
      return workersai(spec, { sessionAffinity: options?.sessionAffinity });
    }
    case "openrouter": {
      if (!env.OPENROUTER_API_KEY) {
        throw new Error(`TEXT_MODEL=${spec} needs OPENROUTER_API_KEY`);
      }
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      return openrouter(model);
    }
    default:
      throw new Error(`TEXT_MODEL=${spec} names an unknown host; use @cf or @openrouter`);
  }
}

/** Shown verbatim in the host header, so it reads back as a pasteable spec. */
export function modelLabel(env: Env): string {
  return textSpec(env);
}
