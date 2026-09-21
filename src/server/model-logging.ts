import type { LanguageModelMiddleware } from "ai";

/**
 * One line in, one line out, per model call.
 *
 * It exists because a failing turn is otherwise silent: `streamText` does not
 * throw on a provider failure, it delivers one as an `error` part inside the
 * stream, so a turn can end with nothing in the thread and nothing in the
 * console. The finish line also catches the other silent failure — a model
 * that answers with neither text nor a tool call.
 *
 * Middleware rather than logging at the call site, because it sits below the
 * provider split in `model.ts`: one tap covers `@cf` and `@openrouter` alike.
 */

/** Workers AI reports both of these as nested objects; OpenRouter as scalars. */
function finishText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  const unified = (reason as { unified?: unknown; type?: unknown } | null) ?? {};
  const named = unified.unified ?? unified.type;
  return typeof named === "string" ? named : JSON.stringify(reason);
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  const total = (value as { total?: unknown } | null)?.total;
  return typeof total === "number" ? total : undefined;
}

function usageText(usage: unknown): string {
  const record = (usage ?? {}) as Record<string, unknown>;
  const input = tokenCount(record.inputTokens);
  const output = tokenCount(record.outputTokens);
  if (input === undefined && output === undefined) return "usage unknown";
  return `${input ?? "?"} in / ${output ?? "?"} out`;
}

export function logModelCalls(spec: string): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream, params }) => {
      const messages = (params.prompt ?? []).length;
      const tools = (params.tools ?? []).length;
      console.log(`[model] ${spec} ← ${messages} messages, ${tools} tools`);

      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        // A throw is the call never reaching the provider — a bad binding, a
        // missing key. Log before rethrowing, in case the rethrow is swallowed.
        console.error(`[model] ${spec} call threw`, error);
        throw error;
      }

      let text = 0;
      let toolCalls = 0;
      let failed = false;
      const tap = new TransformStream({
        transform(part, controller) {
          const chunk = part as Record<string, unknown>;
          if (chunk.type === "text-delta") text += String(chunk.delta ?? "").length;
          if (chunk.type === "tool-call") toolCalls += 1;
          if (chunk.type === "error") {
            failed = true;
            console.error(`[model] ${spec} → ERROR`, chunk.error);
          }
          if (chunk.type === "finish") {
            console.log(
              `[model] ${spec} → finish ${finishText(chunk.finishReason)}, ${usageText(
                chunk.usage,
              )}, ${text} chars, ${toolCalls} tool calls`,
            );
            if (!failed && text === 0 && toolCalls === 0) {
              console.warn(`[model] ${spec} → no text and no tool calls; the thread gains nothing`);
            }
          }
          controller.enqueue(part);
        },
      });

      return { ...result, stream: result.stream.pipeThrough(tap) };
    },
  };
}
