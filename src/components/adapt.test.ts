import { describe, expect, it } from "vitest";
import type { ChatMessageData, ChatUser } from "@/components/ui/chatcn/types";
import type { ActivityMessageData } from "@/components/dembrane/Activity";
import type { RecordingMeta } from "../types";
import {
  createTimestampBook,
  describeParticipants,
  recordingIdsOf,
  toConversationMessages,
  type AgentMessage,
} from "./adapt";

const USER: ChatUser = { id: "device", name: "You" };

describe("describeParticipants", () => {
  it("counts the device on its own until the conversation says otherwise", () => {
    expect(describeParticipants(null)).toBe("1 device");
    expect(describeParticipants({ name: null, participants: null })).toBe("1 device");
  });

  it("names the people in the conversation, and the one device they share", () => {
    expect(describeParticipants({ name: null, participants: 1 })).toBe("1 participant (1 device)");
    expect(describeParticipants({ name: null, participants: 4 })).toBe("4 participants (1 device)");
  });
});

describe("a call's activity card", () => {
  const transcript = `${"we talked about the harbour and then the ferries ".repeat(20)}`;

  it("trims the transcript on the card but keeps all of it behind the click", () => {
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "assistant",
        metadata: { kind: "voice-call" },
        parts: [{ type: "text", text: `Voice call transcript:\n${transcript}` }],
      },
    ];

    const [call] = toConversationMessages(
      messages,
      USER,
      createTimestampBook(() => 0),
    );
    if (!call || !("activity" in call)) throw new Error("expected an activity");

    expect(call.activity.description?.length).toBeLessThanOrEqual(80);
    expect(call.activity.description?.endsWith("…")).toBe(true);
    expect(call.activity.detail).toBe(transcript);
  });
});

describe("a call's voice note", () => {
  const started: AgentMessage = {
    id: "m1",
    role: "user",
    metadata: { kind: "call-started", recordingId: "rec-1" },
    parts: [{ type: "text", text: "Voice call started" }],
  };

  /** What `toConversationMessages` is given by the pane, minus the defaults. */
  function convert(messages: AgentMessage[], meta?: Record<string, RecordingMeta>) {
    return toConversationMessages(
      messages,
      USER,
      createTimestampBook(() => 0),
      {
        recordingHref: (id) => `/recordings/e/c/${id}.wav`,
        recordings: meta ?? {},
      },
    );
  }

  it("renders the start of a call as a voice note, not as its text", () => {
    const [message] = convert([started]) as ChatMessageData[];
    expect(message.voice?.url).toBe("/recordings/e/c/rec-1.wav");
    // The text part exists only so the model has something to read.
    expect(message.text).toBeUndefined();
  });

  it("survives the filter that drops messages with nothing to show", () => {
    expect(convert([started])).toHaveLength(1);
  });

  it("has no length or bars until the first audio has been flushed", () => {
    const [message] = convert([started]) as ChatMessageData[];
    expect(message.voice).toMatchObject({ duration: 0, waveform: [] });
  });

  it("asks for a different url once the call is over, so the player reloads", () => {
    const [live] = convert([started], {
      "rec-1": { ended: false, durationSec: 2, waveform: [0.2] },
    }) as ChatMessageData[];
    const [done] = convert([started], {
      "rec-1": { ended: true, durationSec: 12, waveform: [0.2] },
    }) as ChatMessageData[];

    // The live body is an unknown-length stream and cannot be seeked. Without a
    // different url the element keeps the one it already loaded, and a finished
    // call stays unseekable until the page is reloaded.
    expect(done.voice?.url).not.toBe(live.voice?.url);
  });

  it("takes its length and bars from the recording's own metadata", () => {
    const [message] = convert([started], {
      "rec-1": { ended: true, durationSec: 42.5, waveform: [0.1, 0.8] },
    }) as ChatMessageData[];
    expect(message.voice).toMatchObject({ duration: 42.5, waveform: [0.1, 0.8] });
  });

  it("is attributed to the conversation, so it sits on the participant's side", () => {
    const [message] = convert([started]) as ChatMessageData[];
    expect(message.senderId).toBe(USER.id);
  });

  it("leaves the end of the call as the activity card it already was", () => {
    const ended: AgentMessage = {
      id: "m2",
      role: "user",
      metadata: { kind: "voice-call", recordingId: "rec-1", durationSec: 42.5 },
      parts: [{ type: "text", text: "Voice call transcript:\nwe talked about the harbour" }],
    };
    const [message] = convert([ended]) as ActivityMessageData[];
    expect(message.activity.title).toBe("Voice call");
    expect(message.activity.detail).toBe("we talked about the harbour");
  });
});

describe("recordingIdsOf", () => {
  it("finds the recording each call in the thread is writing into", () => {
    expect(
      recordingIdsOf([
        { id: "m1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
        {
          id: "m2",
          role: "user",
          metadata: { kind: "call-started", recordingId: "rec-1" },
          parts: [],
        },
        {
          id: "m3",
          role: "user",
          metadata: { kind: "voice-call", recordingId: "rec-1" },
          parts: [],
        },
        {
          id: "m4",
          role: "user",
          metadata: { kind: "call-started", recordingId: "rec-2" },
          parts: [],
        },
      ]),
    ).toEqual(["rec-1", "rec-2"]);
  });

  it("is empty for a thread with no calls in it", () => {
    expect(recordingIdsOf([{ id: "m1", role: "user", parts: [] }])).toEqual([]);
  });
});
