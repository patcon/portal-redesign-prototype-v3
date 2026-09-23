import { describe, expect, it } from "vitest";
import { withPauseMarkers } from "./liveTranscript";

describe("withPauseMarkers", () => {
  it("leaves a transcript with no pauses alone", () => {
    expect(withPauseMarkers("we were talking about the harbour", [])).toBe(
      "we were talking about the harbour",
    );
  });

  it("splices a marker in where the call was paused", () => {
    expect(
      withPauseMarkers("before after", [{ at: 6, marker: "[paused 0:28]" }]),
    ).toBe("before [paused 0:28] after");
  });

  it("keeps several pauses in the order they happened", () => {
    expect(
      withPauseMarkers("one two three", [
        { at: 3, marker: "[paused 0:05]" },
        { at: 7, marker: "[paused 1:00]" },
      ]),
    ).toBe("one [paused 0:05] two [paused 1:00] three");
  });

  it("puts a pause before anything has been heard at the front", () => {
    expect(withPauseMarkers("after", [{ at: 0, marker: "[paused 0:09]" }])).toBe(
      "[paused 0:09] after",
    );
  });

  it("shows a pause that nothing has been said since at the end", () => {
    // The mark goes in the moment the microphone comes back, which is before
    // the first word after it has been transcribed.
    expect(withPauseMarkers("before", [{ at: 6, marker: "[paused 0:12]" }])).toBe(
      "before [paused 0:12]",
    );
  });

  it("ignores an offset past the end, which a stale marker would have", () => {
    expect(withPauseMarkers("short", [{ at: 99, marker: "[paused 0:03]" }])).toBe(
      "short [paused 0:03]",
    );
  });
});
