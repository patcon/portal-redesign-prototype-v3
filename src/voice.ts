import { AgentClient } from "agents/client";
import { VoiceClient } from "agents/voice/client";
import type { VoiceTransport, VoiceTransportCloseInfo } from "agents/voice";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The SDK's voice transport addresses an agent by class and instance name,
 * but a table is only reachable through its event hub's route. This is the
 * same socket, pointed at that route with `basePath` — the hub resolves the
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
      host: location.host
    });
    socket.addEventListener("open", () => this.onopen?.());
    socket.addEventListener("close", (event) =>
      this.onclose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      })
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
 * A table's call: microphone in, live transcript out. The server accumulates
 * the transcript and, when the call ends, leaves it in the thread.
 */
export function useCall(basePath: string) {
  const client = useRef<VoiceClient | null>(null);
  const [inCall, setInCall] = useState(false);
  const [heard, setHeard] = useState("");
  const [interim, setInterim] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const voice = new VoiceClient({
      agent: "group-chat",
      transport: new RoutedVoiceTransport(basePath)
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
            .join(" ")
        ),
      interimtranscript: () => setInterim(voice.interimTranscript),
      audiolevelchange: () => setLevel(voice.audioLevel),
      error: () => setError(voice.error)
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
    void client.current?.startCall();
  }, []);
  const stop = useCallback(() => client.current?.endCall(), []);

  return { inCall, heard, interim, level, error, start, stop };
}
