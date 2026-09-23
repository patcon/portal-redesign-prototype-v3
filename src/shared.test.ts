import { describe, expect, it } from "vitest";
import { pauseMarker } from "./shared";

describe("pauseMarker", () => {
  it("says how long the recording was paused for", () => {
    expect(pauseMarker(28_000)).toBe("[paused 0:28]");
  });

  it("counts minutes the way the call timer does", () => {
    expect(pauseMarker(154_000)).toBe("[paused 2:34]");
    expect(pauseMarker(3_723_000)).toBe("[paused 1:02:03]");
  });

  it("rounds to whole seconds, so it never reads as 0:07.4", () => {
    expect(pauseMarker(7_400)).toBe("[paused 0:07]");
  });
});
