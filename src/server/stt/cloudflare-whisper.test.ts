import { describe, expect, it, vi } from "vitest";
import { cloudflareWhisper } from "./cloudflare-whisper";

const SAMPLE_RATE = 16000;

function speech(ms: number): ArrayBuffer {
  const samples = new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE));
  samples.fill(8000);
  return samples.buffer;
}

function silence(ms: number): ArrayBuffer {
  return new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE)).buffer;
}

/** Just the one method of the AI binding this transport touches. */
function fakeAI(result: { text: string } | Error) {
  const run = vi.fn<(model: string, input: unknown) => Promise<{ text: string }>>(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return { ai: { run } as unknown as Ai, run };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Feeds one utterance and waits for the flush to settle. */
async function say(session: { feed: (chunk: ArrayBuffer) => void }) {
  session.feed(speech(500));
  session.feed(silence(800));
  await settle();
}

describe("cloudflareWhisper", () => {
  it("runs the model it was named with", async () => {
    const { ai, run } = fakeAI({ text: "hello" });
    const session = cloudflareWhisper(ai, "@cf/openai/whisper-tiny-en").createSession({});
    await say(session);
    expect(run.mock.calls[0][0]).toBe("@cf/openai/whisper-tiny-en");
  });

  // The binding takes the clip as an array of 8-bit unsigned values, not the
  // ArrayBuffer or a typed array — anything else comes back as a 400.
  it("sends the WAV as an array of byte values", async () => {
    const { ai, run } = fakeAI({ text: "hello" });
    const session = cloudflareWhisper(ai, "@cf/openai/whisper-tiny-en").createSession({});
    await say(session);

    const input = run.mock.calls[0][1] as { audio: number[] };
    expect(Array.isArray(input.audio)).toBe(true);
    expect(input.audio.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)).toBe(
      true,
    );
    // A WAV, byte for byte: the RIFF magic survives the conversion.
    expect(String.fromCharCode(...input.audio.slice(0, 4))).toBe("RIFF");
  });

  it("emits the transcription the model returned", async () => {
    const { ai } = fakeAI({ text: "hello there" });
    const onUtterance = vi.fn<(text: string) => void>();
    const session = cloudflareWhisper(ai, "@cf/openai/whisper-tiny-en").createSession({
      onUtterance,
    });
    await say(session);
    expect(onUtterance).toHaveBeenCalledWith("hello there");
  });

  it("reports a binding failure as fatal", async () => {
    const { ai } = fakeAI(new Error("5035: not available on the Workers Free plan"));
    const onFatalError = vi.fn<(error: Error) => void>();
    const session = cloudflareWhisper(ai, "@cf/openai/whisper-tiny-en").createSession({
      onFatalError,
    });
    await say(session);
    expect(onFatalError).toHaveBeenCalledTimes(1);
  });
});
