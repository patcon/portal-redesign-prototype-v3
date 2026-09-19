/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatUser } from "@/components/ui/chatcn/types";

// The two text sockets. Neither is what these tests are about, and both would
// reach for a real WebSocket on mount, so they are replaced wholesale with the
// shape `ChatPane` reads off them.
vi.mock("agents/react", () => ({ useAgent: () => ({}) }));
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({ messages: [], sendMessage: vi.fn<() => void>(), status: "ready" }),
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

  it("offers no call when calls are disabled", () => {
    renderPane({ callable: false });

    expect(screen.queryByRole("button", { name: "Start call" })).toBeNull();
  });

  it("opens no voice socket at all when calls are disabled", () => {
    renderPane({ callable: false });

    expect(built).toHaveLength(0);
  });

  it("tells a header-actions slot that calls are disabled", () => {
    const actions = vi.fn<() => null>(() => null);
    renderPane({ callable: false, actions });

    expect(actions).toHaveBeenCalledWith(expect.objectContaining({ callable: false }));
  });
});
