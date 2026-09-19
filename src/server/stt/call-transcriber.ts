import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";

/** What one live call has said, and how much audio it took to say it. */
type CallState = {
  chunks: number;
  bytes: number;
  interims: number;
  finals: number;
  /** Interim text heard since the last final; empty once a final absorbs it. */
  trailing: string;
};

/**
 * The transcriber the conversation actually uses: the configured provider,
 * plus the two things a call needs that the provider does not give us.
 *
 * **Terminal logging.** Sitting on the boundary between "audio reached the
 * Worker" and "text came back" is what tells the failure modes apart: no
 * `feed` lines means the browser never sent audio; `feed` lines with no
 * `interim`/`FINAL` means the provider is deaf or dead; a `FATAL` line names
 * a broken provider outright.
 *
 * **Trailing interim.** Deepgram only emits a final on `speech_final`, which
 * needs its endpointer to detect a pause. Steady background noise — a fan, a
 * busy room, exactly the setting this portal is built for — can keep that
 * from ever firing, and the speech is then lost when the socket closes. So we
 * keep the interim text heard since the last final: {@link takeTrailingInterim}
 * hands it back at hang-up, and a final clears it, so nothing is written twice.
 */
export class CallTranscriber implements Transcriber {
  #inner: Transcriber;
  #provider: string;

  /** Live calls, by connection id. */
  #calls = new Map<string, CallState>();

  /**
   * The session created but not yet tied to a connection. The voice mixin
   * creates the session and waits for it to be ready *before* it calls
   * `onCallStart`, so there is one unclaimed session at a time and
   * {@link claim} is what gives it a name.
   */
  #pending: CallState | null = null;

  constructor(inner: Transcriber, provider: string) {
    this.#inner = inner;
    this.#provider = provider;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    const state: CallState = { chunks: 0, bytes: 0, interims: 0, finals: 0, trailing: "" };
    this.#pending = state;
    console.log(`[stt] ${this.#provider}: opening session`);

    const session = this.#inner.createSession({
      ...options,
      onInterim: (text) => {
        state.interims += 1;
        state.trailing = text;
        // Interims fire many times a second; a sample is enough to prove life.
        if (state.interims === 1 || state.interims % 10 === 0) {
          console.log(`[stt] interim #${state.interims}: ${JSON.stringify(text.slice(-60))}`);
        }
        options?.onInterim?.(text);
      },
      onSpeechStart: (text) => {
        console.log("[stt] speech started");
        options?.onSpeechStart?.(text);
      },
      onUtterance: (transcript) => {
        state.finals += 1;
        // This final carries everything the interims were building towards.
        state.trailing = "";
        console.log(`[stt] FINAL #${state.finals}: ${JSON.stringify(transcript)}`);
        options?.onUtterance?.(transcript);
      },
      onFatalError: (error) => {
        console.error(`[stt] FATAL: ${error.message}`);
        options?.onFatalError?.(error);
      },
    });

    const wrapped: TranscriberSession = {
      feed(chunk) {
        state.chunks += 1;
        state.bytes += chunk.byteLength;
        if (state.chunks === 1) console.log(`[stt] first audio chunk (${chunk.byteLength} bytes)`);
        else if (state.chunks % 50 === 0) {
          console.log(`[stt] audio: ${state.chunks} chunks, ${(state.bytes / 1024).toFixed(0)}KB`);
        }
        session.feed(chunk);
      },
      close: () => {
        console.log(
          `[stt] session closed — ${state.chunks} chunks, ${state.interims} interim, ${state.finals} final`,
        );
        session.close();
      },
    };

    if (session.waitUntilReady) {
      wrapped.waitUntilReady = async () => {
        try {
          await session.waitUntilReady?.();
          console.log(`[stt] ${this.#provider}: session READY, accepting audio`);
        } catch (error) {
          console.error(`[stt] ${this.#provider}: session FAILED to start —`, error);
          throw error;
        }
      };
    }
    if (session.flush) {
      wrapped.flush = () => {
        console.log(`[stt] flush requested (client muted mid-utterance)`);
        session.flush?.();
      };
    }
    if (session.updateAgentContext) {
      wrapped.updateAgentContext = (text) => session.updateAgentContext?.(text);
    }
    return wrapped;
  }

  /** Tie the session just created to the connection that will hang it up. */
  claim(connectionId: string): void {
    if (!this.#pending) return;
    this.#calls.set(connectionId, this.#pending);
    this.#pending = null;
  }

  /**
   * The speech heard since this call's last final, or null if there is none.
   * Consumed: a second read returns null, so an ended call cannot write the
   * same words into the thread twice.
   */
  takeTrailingInterim(connectionId: string): string | null {
    const state = this.#calls.get(connectionId);
    if (!state) return null;
    const trailing = state.trailing.trim();
    state.trailing = "";
    return trailing === "" ? null : trailing;
  }

  /** Forget a call once it has ended. */
  release(connectionId: string): void {
    this.#calls.delete(connectionId);
  }
}
