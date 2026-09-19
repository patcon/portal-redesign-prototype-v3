import { describe, expect, it } from "vitest";
import { WorkersAIFluxSTT, WorkersAINova3STT } from "agents/voice";
import { getTranscriber, selectTranscriber, sttLabel } from "./index";

const env = (vars: Partial<Record<string, string>> = {}) =>
  ({ AI: { run: () => Promise.resolve({ text: "" }) }, ...vars }) as unknown as Env;

describe("selectTranscriber", () => {
  it("builds the streaming Deepgram providers for their own ids", () => {
    expect(selectTranscriber(env(), "@cf/deepgram/nova-3")).toBeInstanceOf(WorkersAINova3STT);
    expect(selectTranscriber(env(), "@cf/deepgram/flux")).toBeInstanceOf(WorkersAIFluxSTT);
  });

  // Whisper is batch, so both hosts come back as our own VAD-driven wrapper
  // rather than an `agents/voice` class — the same model either side of the
  // host switch.
  it.each(["@cf/openai/whisper-tiny-en", "@local/openai/whisper-tiny-en"])(
    "builds a VAD-driven transcriber for %s",
    (spec) => {
      const transcriber = selectTranscriber(env(), spec);
      expect(transcriber).not.toBeInstanceOf(WorkersAINova3STT);
      expect(typeof transcriber.createSession).toBe("function");
    },
  );

  // Unlike TEXT_MODEL, this is a fixed menu: `agents/voice` has a class per
  // streaming provider and whisper needs our own VAD. A well-formed Workers AI
  // id that is simply not wired up must not read as a typo, so the error lists
  // what does work.
  it("lists the supported ids when a real Workers AI model is not one of them", () => {
    expect(() => selectTranscriber(env(), "@cf/openai/whisper-large-v3-turbo")).toThrow(
      /@cf\/openai\/whisper-tiny-en[\s\S]*@cf\/deepgram\/nova-3/,
    );
  });

  it("rejects an unknown host", () => {
    expect(() => selectTranscriber(env(), "@deepgram/nova-3")).toThrow(/STT_MODEL/);
  });

  it("rejects a malformed spec by name", () => {
    expect(() => selectTranscriber(env(), "nova-3")).toThrow(/STT_MODEL/);
  });
});

describe("getTranscriber", () => {
  it("defaults to Workers AI whisper, which needs no WebSocket", () => {
    expect(sttLabel(env())).toBe("@cf/openai/whisper-tiny-en");
    expect(() => getTranscriber(env())).not.toThrow();
  });

  it("wraps the chosen provider so calls keep their logging and salvage", () => {
    const transcriber = getTranscriber(env({ STT_MODEL: "@cf/deepgram/nova-3" }));
    expect(transcriber).not.toBeInstanceOf(WorkersAINova3STT);
    expect(typeof transcriber.takeTrailingInterim).toBe("function");
  });
});

describe("sttLabel", () => {
  it("is the spec itself, ready to paste back", () => {
    expect(sttLabel(env({ STT_MODEL: "@local/openai/whisper-tiny-en" }))).toBe(
      "@local/openai/whisper-tiny-en",
    );
  });
});
