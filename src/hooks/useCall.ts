import { AgentClient } from "agents/client";
import { VoiceClient } from "agents/voice/client";
import type { VoiceTransport, VoiceTransportCloseInfo } from "agents/voice";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The SDK's voice transport addresses an agent by class and instance name,
 * but a conversation is only reachable through its event hub's route. This is
 * the same socket, pointed at that route with `basePath` — the hub resolves the
 * chat and the chat's own Durable Object answers, exactly as for text.
 */
class RoutedVoiceTransport implements VoiceTransport {
  #socket: AgentClient | null = null;

  onopen: (() => void) | null = null;
  onclose: ((info?: VoiceTransportCloseInfo) => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  constructor(readonly basePath: string) {}

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  sendJSON(data: Record<string, unknown>): void {
    if (this.connected) this.#socket?.send(JSON.stringify(data));
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.connected) this.#socket?.send(data);
  }

  connect(): void {
    if (this.#socket) return;
    const socket = new AgentClient({
      agent: "group-chat",
      basePath: this.basePath,
      host: location.host,
    });
    socket.addEventListener("open", () => this.onopen?.());
    socket.addEventListener("close", (event) =>
      this.onclose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      }),
    );
    socket.addEventListener("error", (event) => this.onerror?.(event));
    socket.addEventListener("message", (event) => this.onmessage?.(event.data));
    this.#socket = socket;
  }

  disconnect(): void {
    this.#socket?.close();
    this.#socket = null;
  }
}

/**
 * A conversation's call: microphone in, live transcript out. The server
 * accumulates the transcript and, when the call ends, leaves it in the thread.
 */
export function useCall(basePath: string) {
  const client = useRef<VoiceClient | null>(null);
  const [inCall, setInCall] = useState(false);
  const [heard, setHeard] = useState("");
  const [interim, setInterim] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const voice = new VoiceClient({
      agent: "group-chat",
      transport: new RoutedVoiceTransport(basePath),
    });
    client.current = voice;
    voice.connect();

    const sync = {
      statuschange: () => setInCall(voice.status !== "idle"),
      transcriptchange: () =>
        setHeard(
          voice.transcript
            .filter((message) => message.role === "user")
            .map((message) => message.text)
            .join(" "),
        ),
      interimtranscript: () => setInterim(voice.interimTranscript),
      audiolevelchange: () => setLevel(voice.audioLevel),
      mutechange: () => setMuted(voice.isMuted),
      error: () => setError(voice.error),
    } as const;
    for (const [name, listener] of Object.entries(sync)) {
      voice.addEventListener(name as keyof typeof sync, listener);
    }
    return () => {
      for (const [name, listener] of Object.entries(sync)) {
        voice.removeEventListener(name as keyof typeof sync, listener);
      }
      voice.disconnect();
    };
  }, [basePath]);

  const start = useCallback(() => {
    setHeard("");
    setError(null);
    const voice = client.current;
    if (!voice) return;
    // A call always begins live. The voice client outlives any one call and never
    // clears its own mute, so a call ended while muted would otherwise hand its
    // mute to the next one — which, now that muting really does gate the
    // microphone, would be a call that silently transcribes nothing.
    if (voice.isMuted) voice.toggleMute();
    void voice.startCall();
  }, []);
  const stop = useCallback(() => client.current?.endCall(), []);
  /**
   * Mute really does stop the transcription. The voice client drops microphone
   * frames instead of sending them while muted, and if the mute lands in the
   * middle of an utterance it sends `end_of_speech` so the server transcribes
   * what it already has rather than waiting for a silence that can never arrive
   * — no frames means no silence detection. So `muted` is the client's own state
   * echoed back, never a separate flag the UI keeps.
   */
  const toggleMute = useCallback(() => client.current?.toggleMute(), []);

  return { inCall, heard, interim, level, muted, error, start, stop, toggleMute };
}
