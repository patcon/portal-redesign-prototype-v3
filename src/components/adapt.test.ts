import { describe, expect, it } from "vitest";
import type { ChatUser } from "@/components/ui/chatcn/types";
import {
  createTimestampBook,
  describeParticipants,
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
