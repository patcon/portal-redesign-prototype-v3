import { describe, expect, it, vi } from "vitest";

/**
 * The two provider factories are faked at the module boundary — the real ones
 * would need a live AI binding and an OpenRouter key, and what is worth
 * testing is only which of them gets called, with which id.
 */
type FakeModel = { tag: string; model: string; options?: unknown };

const workersAI = vi.fn<(model: string, options?: unknown) => FakeModel>((model, options) => ({
  tag: "workers-ai",
  model,
  options,
}));
const openRouter = vi.fn<(model: string) => FakeModel>((model) => ({
  tag: "openrouter",
  model,
}));
const createWorkersAI = vi.fn<(config: unknown) => typeof workersAI>(() => workersAI);
const createOpenRouter = vi.fn<(config: unknown) => typeof openRouter>(() => openRouter);

vi.mock("workers-ai-provider", () => ({ createWorkersAI: (c: unknown) => createWorkersAI(c) }));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: (c: unknown) => createOpenRouter(c),
}));

const { getModel, modelLabel } = await import("./model");

const env = (vars: Partial<Record<string, string>> = {}) =>
  ({ AI: { binding: true }, ...vars }) as unknown as Env;

describe("getModel", () => {
  // Workers AI ids keep their `@cf/` prefix — the spec *is* the model id, so
  // it goes through whole rather than being reassembled.
  it("passes a Workers AI spec through unchanged", () => {
    const model = getModel(env({ TEXT_MODEL: "@cf/moonshotai/kimi-k2.7-code" }));
    expect(model).toMatchObject({ tag: "workers-ai", model: "@cf/moonshotai/kimi-k2.7-code" });
  });

  it("forwards session affinity to Workers AI", () => {
    getModel(env({ TEXT_MODEL: "@cf/moonshotai/kimi-k2.7-code" }), { sessionAffinity: "abc" });
    expect(workersAI.mock.lastCall?.[1]).toEqual({ sessionAffinity: "abc" });
  });

  // OpenRouter names its own vendor, so the host prefix is dropped and the
  // rest — slash included — is the id it expects.
  it("strips the host from an OpenRouter spec", () => {
    const model = getModel(
      env({ TEXT_MODEL: "@openrouter/anthropic/claude-haiku-4.5", OPENROUTER_API_KEY: "sk-test" }),
    );
    expect(model).toMatchObject({ tag: "openrouter", model: "anthropic/claude-haiku-4.5" });
    expect(createOpenRouter).toHaveBeenCalledWith({ apiKey: "sk-test" });
  });

  it("defaults to a Workers AI model that needs no key and no paid plan", () => {
    expect(getModel(env())).toMatchObject({
      tag: "workers-ai",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
  });

  it("says which key is missing when OpenRouter has none", () => {
    expect(() => getModel(env({ TEXT_MODEL: "@openrouter/anthropic/claude-haiku-4.5" }))).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("lists the hosts it knows when given an unknown one", () => {
    expect(() => getModel(env({ TEXT_MODEL: "@together/meta/llama-3" }))).toThrow(
      /@cf.*@openrouter/,
    );
  });

  it("rejects a malformed spec by name", () => {
    expect(() => getModel(env({ TEXT_MODEL: "llama-3" }))).toThrow(/TEXT_MODEL/);
  });
});

describe("modelLabel", () => {
  // The host console shows this verbatim, so it has to be the string you
  // would paste straight back into `.dev.vars`.
  it("is the spec itself", () => {
    expect(modelLabel(env({ TEXT_MODEL: "@openrouter/anthropic/claude-haiku-4.5" }))).toBe(
      "@openrouter/anthropic/claude-haiku-4.5",
    );
  });

  it("resolves the default rather than showing an empty string", () => {
    expect(modelLabel(env())).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});
