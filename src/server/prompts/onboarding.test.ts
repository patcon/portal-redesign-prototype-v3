import { describe, expect, it } from "vitest";
import { conversationStatus } from "./onboarding";

const state = { name: null, participants: null };

describe("conversationStatus", () => {
  // Modelled on pizzo's "Current song:" block: a labelled dash list, rebuilt
  // each turn, with absent values spelled out rather than omitted.
  it("reads back what is recorded", () => {
    expect(
      conversationStatus({ name: "Kitchen crew", participants: 5 }, { hasTranscript: true }),
    ).toContain(
      [
        "Current conversation:",
        "- Name: Kitchen crew",
        "- Participants: 5",
        "- Voice recording: at least one call recorded",
      ].join("\n"),
    );
  });

  // The loop came from the model being unable to tell "not set" from "unknown",
  // so an unset value has to say so in words rather than go missing.
  it("says in words when nothing is recorded yet", () => {
    const status = conversationStatus(state, { hasTranscript: false });
    expect(status).toContain("- Name: not yet chosen");
    expect(status).toContain("- Participants: not yet recorded");
    expect(status).toContain("- Voice recording: nothing recorded yet");
  });

  it("names a solo participant as a count like any other", () => {
    expect(conversationStatus({ name: null, participants: 1 }, { hasTranscript: false })).toContain(
      "- Participants: 1",
    );
  });

  it("tells the model not to re-set what is already there", () => {
    const status = conversationStatus({ name: "A", participants: 2 }, { hasTranscript: false });
    expect(status.toLowerCase()).toMatch(/already|do not call/);
  });
});
