/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatMessage, ChatProvider, VOICE_TRACK_BARS } from "./index";
import type { ChatMessageData, ChatUser } from "./types";

const ME: ChatUser = { id: "me", name: "Me" };

const VOICE: ChatMessageData = {
  id: "m1",
  senderId: "them",
  senderName: "Them",
  timestamp: new Date("2026-01-01T12:00:00Z"),
  voice: { url: "/recordings/e/c/r.wav", duration: 30, waveform: [0.2, 0.9, 0.4] },
};

function renderVoice(message: ChatMessageData = VOICE) {
  return render(
    <ChatProvider currentUser={ME}>
      <ChatMessage message={message} isOutgoing={false} position="solo" />
    </ChatProvider>,
  );
}

/** The `<audio>` the voice note drives, which has no role of its own. */
function audioElement(container: HTMLElement): HTMLAudioElement {
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("voice note rendered no audio element");
  return audio;
}

describe("ChatVoiceMessage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    // jsdom implements no media pipeline, so these throw "not implemented"
    // unless stubbed. Everything asserted below is about what the component
    // asks the element to do, which is exactly what the stubs record.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  it("points at the audio it was given", () => {
    const { container } = renderVoice();
    expect(audioElement(container).getAttribute("src")).toBe("/recordings/e/c/r.wav");
  });

  it("plays the real audio when the button is pressed", () => {
    const { container } = renderVoice();
    fireEvent.click(screen.getByRole("button", { name: /play voice message/i }));

    expect(audioElement(container).play).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /pause voice message/i })).toBeTruthy();
  });

  it("pauses it again rather than letting a fake clock run on", () => {
    const { container } = renderVoice();
    fireEvent.click(screen.getByRole("button", { name: /play voice message/i }));
    fireEvent.click(screen.getByRole("button", { name: /pause voice message/i }));

    expect(audioElement(container).pause).toHaveBeenCalled();
  });

  it("follows the element's own clock, not a timer of its own", () => {
    const { container } = renderVoice();
    const audio = audioElement(container);

    Object.defineProperty(audio, "currentTime", { value: 15, configurable: true });
    fireEvent.timeUpdate(audio);

    // Half of a 30s recording played: the label counts up from the elapsed
    // time the element reports.
    expect(screen.getByText("0:15")).toBeTruthy();
  });

  it("shows the whole length before anything has played", () => {
    renderVoice();
    expect(screen.getByText("0:30")).toBeTruthy();
  });

  it("shows the title the voice note was given", () => {
    renderVoice({
      ...VOICE,
      voice: { ...VOICE.voice!, title: "Voice call started" },
    });
    expect(screen.getByText("Voice call started")).toBeTruthy();
  });

  it("will not play or seek a locked recording", () => {
    const { container } = renderVoice({
      ...VOICE,
      voice: { ...VOICE.voice!, locked: true },
    });

    const play = screen.getByRole("button", { name: /play voice message/i });
    expect(play.hasAttribute("disabled")).toBe(true);
    // Disabled rather than gone: the note still has to look like a voice note.
    for (const bar of container.querySelectorAll("[data-slot='chat-voice-bar']")) {
      expect(bar.hasAttribute("disabled")).toBe(true);
    }
  });

  it("draws one bar per waveform sample", () => {
    const { container } = renderVoice();
    expect(container.querySelectorAll("[data-slot='chat-voice-bar']")).toHaveLength(3);
  });

  it("stops widening once the waveform fills the track", () => {
    const long = Array.from({ length: 500 }, (_, i) => (i % 10) / 10);
    const { container } = renderVoice({
      ...VOICE,
      voice: { ...VOICE.voice!, waveform: long },
    });

    // A call runs as long as it likes; the bubble it sits in does not grow
    // with it. Past the track's capacity the waveform is folded down to fit.
    const bars = container.querySelectorAll("[data-slot='chat-voice-bar']");
    expect(bars).toHaveLength(VOICE_TRACK_BARS);
  });

  it("leaves a full-height target where the recording is silent", () => {
    const { container } = renderVoice({
      ...VOICE,
      voice: { ...VOICE.voice!, waveform: [0, 0, 0] },
    });

    // A bar as tall as its sample is nothing to aim at when the sample is
    // silence, so the click target spans the track's height — but stays
    // invisible, or it would draw over the waveform's own shape.
    const bars = container.querySelectorAll("[data-slot='chat-voice-bar']");
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.className).toContain("h-full");
      expect(bar.className).toContain("bg-transparent");
    }
  });

  it("keeps folded bars seeking across the whole recording", () => {
    const long = Array.from({ length: 500 }, () => 0.5);
    renderVoice({ ...VOICE, voice: { ...VOICE.voice!, waveform: long } });

    // Each bar stands for a slice of the recording, not for the sample that
    // happens to share its index, so the last one is still the end.
    expect(screen.getByRole("button", { name: /seek to 99%/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /seek to 1%/i })).toBeTruthy();
  });

  it("counts up rather than down while a recording is still being made", () => {
    const { container } = renderVoice({
      ...VOICE,
      voice: { url: "/live.wav", duration: 0, waveform: [0.3] },
    });
    const audio = audioElement(container);

    Object.defineProperty(audio, "currentTime", { value: 7, configurable: true });
    fireEvent.timeUpdate(audio);

    // A live recording has no length to show, so a countdown would be a lie.
    expect(screen.getByText("0:07")).toBeTruthy();
  });

  it("stops claiming to play when the audio fails to load", () => {
    const { container } = renderVoice();
    fireEvent.click(screen.getByRole("button", { name: /play voice message/i }));

    fireEvent.error(audioElement(container));

    // The button is pressed optimistically, so without this a recording that
    // cannot be played looks exactly like one that is playing silently.
    expect(screen.getByRole("button", { name: /play voice message/i })).toBeTruthy();
  });

  it("returns to the start when the audio finishes", () => {
    const { container } = renderVoice();
    fireEvent.click(screen.getByRole("button", { name: /play voice message/i }));
    fireEvent.ended(audioElement(container));

    expect(screen.getByRole("button", { name: /play voice message/i })).toBeTruthy();
    expect(screen.getByText("0:30")).toBeTruthy();
  });
});
