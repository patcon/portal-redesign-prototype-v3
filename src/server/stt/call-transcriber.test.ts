import { describe, expect, it, vi } from "vitest";
import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";
import { CallTranscriber } from "./call-transcriber";

/** A transcriber whose callbacks the test fires by hand. */
function fakeProvider() {
  let options: TranscriberSessionOptions | undefined;
  const session: TranscriberSession = {
    feed: vi.fn<TranscriberSession["feed"]>(),
    close: vi.fn<TranscriberSession["close"]>(),
  };
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

describe("CallTranscriber audio tap", () => {
  it("hands every fed chunk to the recorder as well as the provider", () => {
    const fake = fakeProvider();
    const heard: ArrayBuffer[] = [];
    const tracker = new CallTranscriber(fake.provider, "test", {
      onAudio: (chunk) => heard.push(chunk),
    });
    const session = startCall(tracker, "conn-1");

    const first = new ArrayBuffer(8);
    const second = new ArrayBuffer(16);
    session.feed(first);
    session.feed(second);

    expect(heard).toEqual([first, second]);
    expect(fake.session.feed).toHaveBeenCalledTimes(2);
  });

  it("tags the audio with the session it belongs to", () => {
    const fake = fakeProvider();
    const sessions: string[] = [];
    const tracker = new CallTranscriber(fake.provider, "test", {
      onAudio: (_chunk, sessionId) => sessions.push(sessionId),
    });
    const session = tracker.createSession({});
    const claimed = tracker.claim("conn-1");

    session.feed(new ArrayBuffer(8));

    // The mixin creates the session before it knows the connection, so the
    // session id is what ties the audio to the call that `claim` names.
    expect(claimed).not.toBeNull();
    expect(sessions).toEqual([claimed]);
  });

  it("returns null from claim when no session is waiting to be named", () => {
    const fake = fakeProvider();
    const tracker = new CallTranscriber(fake.provider, "test");
    expect(tracker.claim("conn-1")).toBeNull();
  });

  it("keeps transcribing when the recorder throws", () => {
    const fake = fakeProvider();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tracker = new CallTranscriber(fake.provider, "test", {
      onAudio: () => {
        throw new Error("SQLite is unhappy");
      },
    });
    const session = startCall(tracker, "conn-1");

    const chunk = new ArrayBuffer(8);
    // Losing the recording is bad; losing the call because of it is worse.
    expect(() => session.feed(chunk)).not.toThrow();
    expect(fake.session.feed).toHaveBeenCalledWith(chunk);
    error.mockRestore();
  });
});
