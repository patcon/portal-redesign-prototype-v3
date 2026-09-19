import { describe, expect, it } from "vitest";
import { parseModelSpec } from "./model-spec";

describe("parseModelSpec", () => {
  it("splits a Workers AI id into its host and the rest", () => {
    expect(parseModelSpec("@cf/moonshotai/kimi-k2.7-code", "TEXT_MODEL")).toEqual({
      host: "cf",
      model: "moonshotai/kimi-k2.7-code",
    });
  });

  // OpenRouter ids contain their own slash, so only the *first* one separates
  // the host from the model. Splitting on every slash would lose the vendor.
  it("keeps the slash inside an OpenRouter id", () => {
    expect(parseModelSpec("@openrouter/anthropic/claude-haiku-4.5", "TEXT_MODEL")).toEqual({
      host: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  it("parses a local id the same way as its hosted twin", () => {
    const hosted = parseModelSpec("@cf/openai/whisper-tiny-en", "STT_MODEL");
    const local = parseModelSpec("@local/openai/whisper-tiny-en", "STT_MODEL");
    expect(local.model).toBe(hosted.model);
    expect(local.host).toBe("local");
  });

  it.each([
    ["cf/openai/whisper-tiny-en", "no leading @"],
    ["@cf", "no slash"],
    ["@cf/", "empty model"],
    ["@/openai/whisper-tiny-en", "empty host"],
    ["", "empty string"],
  ])("rejects %s (%s)", (spec) => {
    expect(() => parseModelSpec(spec, "STT_MODEL")).toThrow(/STT_MODEL/);
  });

  // The message has to show the shape, since the whole point of the scheme is
  // that you paste a catalog id in and it works.
  it("names the expected shape when it rejects", () => {
    expect(() => parseModelSpec("kimi", "TEXT_MODEL")).toThrow(/@host\/model/);
  });
});
