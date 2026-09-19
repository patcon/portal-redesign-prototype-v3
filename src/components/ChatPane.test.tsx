/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatUser } from "@/components/ui/chatcn/types";

// The two text sockets. Neither is what these tests are about, and both would
// reach for a real WebSocket on mount, so they are replaced wholesale with the
// shape `ChatPane` reads off them.
vi.mock("agents/react", () => ({ useAgent: () => ({}) }));
// What the thread contains is per-test, so the mock reads a mutable array the
// test fills in before rendering.
const threadMessages: unknown[] = [];
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({
    messages: threadMessages,
    sendMessage: vi.fn<() => void>(),
    status: "ready",
  }),
}));

/**
 * The voice client, counted rather than driven. Whether one was *constructed*
 * is the question — a conversation with calls disabled should never build the
 * thing, not build one and then decline to speak into it.
 */
const built: FakeVoiceClient[] = [];
class FakeVoiceClient {
  status = "idle";
  transcript: { role: string; text: string }[] = [];
  interimTranscript: string | null = null;
  audioLevel = 0;
  isMuted = false;
  error: string | null = null;
  connect = vi.fn<() => void>();
  disconnect = vi.fn<() => void>();
  addEventListener = vi.fn<() => void>();
  removeEventListener = vi.fn<() => void>();
  startCall = vi.fn<() => void>();
  endCall = vi.fn<() => void>();
  toggleMute = vi.fn<() => void>();
  constructor() {
    built.push(this);
  }
}
vi.mock("agents/voice/client", () => ({ VoiceClient: FakeVoiceClient }));

// Imported after the mocks are declared, which `vi.mock` hoisting arranges
// regardless — stated here so the order reads as deliberate.
const { ChatPane } = await import("./ChatPane");

const USER: ChatUser = { id: "host", name: "Host" };

function renderPane(props: Partial<Parameters<typeof ChatPane>[0]> = {}) {
  return render(
    <ChatPane
      eventId="event-1"
      chatId="chat-1"
      currentUser={USER}
      title="Your thread"
      {...props}
    />,
  );
}

describe("ChatPane", () => {
  beforeEach(() => {
    built.length = 0;
    threadMessages.length = 0;
  });
  afterEach(cleanup);

  it("offers a call by default, over a live voice client", () => {
    renderPane();

    const phone = screen.getByRole("button", { name: "Start call" });
    // The default header button is rendered `disabled` when nothing wires it,
    // so "is it there" is not enough — it has to be live.
    expect(phone.hasAttribute("disabled")).toBe(false);
    expect(built).toHaveLength(1);
    expect(built[0]?.connect).toHaveBeenCalled();
  });

  it("shows the call disabled rather than absent when calls are off", () => {
    renderPane({ callable: false });

    // Kept on screen, greyed: the thread is visibly one that does not take
    // calls, which a missing button would leave the host guessing at.
    const phone = screen.getByRole("button", { name: "Start call" });
    expect(phone.hasAttribute("disabled")).toBe(true);
  });

  it("opens no voice socket at all when calls are disabled", () => {
    renderPane({ callable: false });

    expect(built).toHaveLength(0);
  });

  it("opens a call's full transcript in a drawer when its card is clicked", () => {
    const transcript = `${"the ferries run every twenty minutes ".repeat(20)}end of it`;
    threadMessages.push({
      id: "call-1",
      role: "assistant",
      metadata: { kind: "voice-call" },
      parts: [{ type: "text", text: `Voice call transcript:\n${transcript}` }],
    });
    renderPane();

    // The card shows a trimmed line; the drawer behind it is where the whole
    // call is readable.
    expect(screen.queryByText(transcript)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Voice call/ }));

    expect(screen.getByText(transcript)).toBeTruthy();
  });

  it("does not repeat the card's snippet above the transcript it opens", () => {
    const transcript = `${"the ferries run every twenty minutes ".repeat(20)}end of it`;
    threadMessages.push({
      id: "call-1",
      role: "assistant",
      metadata: { kind: "voice-call" },
      parts: [{ type: "text", text: `Voice call transcript:\n${transcript}` }],
    });
    renderPane();

    // Whatever the card trimmed the call down to — read off the card rather
    // than recomputed, so the trimming stays `adapt`'s business alone.
    const snippet = screen.getByText(/^the ferries run every twenty minutes/).textContent ?? "";
    expect(snippet).not.toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Voice call/ }));

    // Still exactly once, on the card the drawer opened from: the panel holds
    // the call itself, and the snippet is the part already read.
    expect(screen.getAllByText(snippet)).toHaveLength(1);
  });

  it("tells a header-actions slot that calls are disabled", () => {
    const actions = vi.fn<() => null>(() => null);
    renderPane({ callable: false, actions });

    expect(actions).toHaveBeenCalledWith(expect.objectContaining({ callable: false }));
  });
});
