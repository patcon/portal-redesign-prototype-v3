import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { logModelCalls } from "./model-logging";

type Part = Record<string, unknown>;

const streamOf = (parts: Part[]) =>
  new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

const drain = async (stream: ReadableStream<Part>) => {
  const seen: Part[] = [];
  for await (const part of stream as unknown as AsyncIterable<Part>) seen.push(part);
  return seen;
};

const PROMPT = [
  { role: "system", content: "You are a facilitator." },
  { role: "user", content: [{ type: "text", text: "hello there" }] },
];

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const lines = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));

describe("logModelCalls", () => {
  it("logs the spec and the shape of the call before it goes out", async () => {
    const middleware = logModelCalls("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    await middleware.wrapStream!({
      doStream: async () => ({ stream: streamOf([]) }),
      params: { prompt: PROMPT, tools: [{ name: "setConversationName" }] },
    } as never);

    const printed = lines(log).join("\n");
    expect(printed).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(printed).toContain("2 messages, 1 tools");
  });

  it("logs the finish reason and usage once the stream ends", async () => {
    const middleware = logModelCalls("@cf/x");
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({
        stream: streamOf([
          { type: "text-delta", delta: "hi" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 3 } },
        ]),
      }),
      params: { prompt: PROMPT },
    } as never);

    await drain(stream as ReadableStream<Part>);
    const printed = lines(log).join("\n");
    expect(printed).toMatch(/finish stop/);
    expect(printed).toContain("12 in / 3 out");
  });

  // Workers AI reports both as nested objects; `String()` on them printed
  // "[object Object]" and "usage" as unreadable JSON.
  it("reads a finish reason and usage that arrive as objects", async () => {
    const middleware = logModelCalls("@cf/x");
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({
        stream: streamOf([
          { type: "text-delta", delta: "hi" },
          {
            type: "finish",
            finishReason: { type: "tool-calls" },
            usage: { inputTokens: { total: 3410 }, outputTokens: { total: 18 } },
          },
        ]),
      }),
      params: { prompt: PROMPT },
    } as never);

    await drain(stream as ReadableStream<Part>);
    const printed = lines(log).join("\n");
    expect(printed).toContain("finish tool-calls");
    expect(printed).toContain("3410 in / 18 out");
  });

  // What Workers AI actually sent in this prototype's logs, which `String()`
  // printed as "[object Object]".
  it("reads the unified finish reason Workers AI reports", async () => {
    const middleware = logModelCalls("@cf/x");
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({
        stream: streamOf([
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: {} },
        ]),
      }),
      params: { prompt: PROMPT },
    } as never);

    await drain(stream as ReadableStream<Part>);
    expect(lines(log).join("\n")).toContain("finish tool-calls");
  });

  // The silent failure this exists for: the AI SDK delivers a provider
  // failure as a stream part, so nothing is thrown and nothing is logged.
  it("shouts about an error part instead of letting the turn end empty", async () => {
    const middleware = logModelCalls("@cf/x");
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({
        stream: streamOf([{ type: "error", error: new Error("5035: not available") }]),
      }),
      params: { prompt: PROMPT },
    } as never);

    await drain(stream as ReadableStream<Part>);
    expect(lines(error).join("\n")).toContain("5035: not available");
  });

  it("warns when a turn produced no text at all", async () => {
    const middleware = logModelCalls("@cf/x");
    const { stream } = await middleware.wrapStream!({
      doStream: async () => ({
        stream: streamOf([{ type: "finish", finishReason: "stop", usage: {} }]),
      }),
      params: { prompt: PROMPT },
    } as never);

    await drain(stream as ReadableStream<Part>);
    expect(lines(warn).join("\n")).toMatch(/no text/i);
  });

  it("rethrows a call that fails outright, having logged it", async () => {
    const middleware = logModelCalls("@cf/x");
    await expect(
      middleware.wrapStream!({
        doStream: async () => {
          throw new Error("binding unavailable");
        },
        params: { prompt: PROMPT },
      } as never),
    ).rejects.toThrow("binding unavailable");
    expect(lines(error).join("\n")).toContain("binding unavailable");
  });
});
