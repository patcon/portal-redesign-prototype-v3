import { describe, expect, it, vi } from "vitest";
import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";
import { CallTranscriber } from "./call-transcriber";

/** A transcriber whose callbacks the test fires by hand. */
function fakeProvider() {
  let options: TranscriberSessionOptions | undefined;
  const session: TranscriberSession = { feed: vi.fn(), close: vi.fn() };
  const provider: Transcriber = {
    createSession(received) {
      options = received;
      return session;
    },
  };
  return {
    provider,
    session,
    interim: (text: string) => options?.onInterim?.(text),
    final: (text: string) => options?.onUtterance?.(text),
  };
}

/** Open a call the way the voice mixin does: create a session, then start. */
function startCall(tracker: CallTranscriber, connectionId: string) {
  const session = tracker.createSession({});
  tracker.claim(connectionId);
  return session;
}

describe("CallTranscriber trailing interim", () => {
  it("keeps speech that never reached a final", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    startCall(tracker, "conn-1");

    // Constant background noise (a fan) stops Deepgram endpointing, so
    // `speech_final` never fires and this text would otherwise be lost.
    fake.interim("this is a test");

    expect(tracker.takeTrailingInterim("conn-1")).toBe("this is a test");
  });

  it("drops an interim that a final superseded", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    startCall(tracker, "conn-1");

    fake.interim("this is a");
    fake.final("This is a test.");

    // The final already carries this speech; returning it again would
    // duplicate the sentence in the thread.
    expect(tracker.takeTrailingInterim("conn-1")).toBeNull();
  });

  it("keeps only the speech that follows the last final", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    startCall(tracker, "conn-1");

    fake.interim("this is a");
    fake.final("This is a test.");
    fake.interim("and another thought");

    expect(tracker.takeTrailingInterim("conn-1")).toBe("and another thought");
  });

  it("ignores whitespace-only trailing interims", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    startCall(tracker, "conn-1");

    fake.interim("   ");

    expect(tracker.takeTrailingInterim("conn-1")).toBeNull();
  });

  it("consumes the trailing interim, so a call cannot be written twice", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    startCall(tracker, "conn-1");

    fake.interim("this is a test");

    expect(tracker.takeTrailingInterim("conn-1")).toBe("this is a test");
    expect(tracker.takeTrailingInterim("conn-1")).toBeNull();
  });

  it("keeps concurrent calls in the same conversation apart", () => {
    const first = fakeProvider();
    const tracker = new CallTranscriber(first.provider, "test");
    startCall(tracker, "conn-1");
    first.interim("first caller");

    // A second participant starts a call on the same Durable Object.
    const second = fakeProvider();
    const both: Transcriber = { createSession: (o) => second.provider.createSession(o) };
    const tracker2 = new CallTranscriber(both, "test");
    startCall(tracker2, "conn-2");
    second.interim("second caller");

    expect(tracker.takeTrailingInterim("conn-1")).toBe("first caller");
    expect(tracker2.takeTrailingInterim("conn-2")).toBe("second caller");
  });

  it("returns null for a connection that never had a call", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");

    expect(tracker.takeTrailingInterim("never-called")).toBeNull();
  });

  it("still forwards audio and callbacks to the provider", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    const heard: string[] = [];
    const session = tracker.createSession({ onUtterance: (text) => heard.push(text) });
    tracker.claim("conn-1");

    const chunk = new ArrayBuffer(8);
    session.feed(chunk);
    fake.final("This is a test.");
    session.close();

    expect(fake.session.feed).toHaveBeenCalledWith(chunk);
    expect(fake.session.close).toHaveBeenCalled();
    expect(heard).toEqual(["This is a test."]);
  });
});
