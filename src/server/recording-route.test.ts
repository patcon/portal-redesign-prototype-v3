import { describe, expect, it } from "vitest";
import { parseRecordingPath } from "./recording-route";

describe("parseRecordingPath", () => {
  it("reads the event, chat, recording and format out of the path", () => {
    expect(parseRecordingPath("/recordings/event-1/chat-2/rec-3.wav")).toEqual({
      eventId: "event-1",
      chatId: "chat-2",
      recordingId: "rec-3",
      format: "wav",
    });
  });

  it("reads the metadata form too", () => {
    expect(parseRecordingPath("/recordings/e/c/r.json")?.format).toBe("json");
  });

  it("decodes escaped ids rather than handing them on raw", () => {
    expect(parseRecordingPath("/recordings/my%20event/c/r.wav")?.eventId).toBe("my event");
  });

  it("is null for anything that is not a recording", () => {
    expect(parseRecordingPath("/events/event-1")).toBeNull();
    expect(parseRecordingPath("/agents/project-hub/x")).toBeNull();
    expect(parseRecordingPath("/recordings/e/c/r.mp3")).toBeNull();
    expect(parseRecordingPath("/recordings/e/c")).toBeNull();
    expect(parseRecordingPath("/recordings/e/c/r/extra.wav")).toBeNull();
  });

  it("is null when any id is empty", () => {
    expect(parseRecordingPath("/recordings//c/r.wav")).toBeNull();
    expect(parseRecordingPath("/recordings/e//r.wav")).toBeNull();
    expect(parseRecordingPath("/recordings/e/c/.wav")).toBeNull();
  });

  it("does not let an escaped separator smuggle in an extra segment", () => {
    // `%2F` decodes to "/", which must not turn one id into a path of its own.
    expect(parseRecordingPath("/recordings/e/c/..%2F..%2Fsecret.wav")?.recordingId).toBe(
      "../../secret",
    );
  });
});
