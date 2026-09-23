import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice";

/** Told about every frame of audio, so it can be recorded as well as heard. */
export type AudioTap = (chunk: ArrayBuffer, sessionId: string) => void;

export type CallTranscriberOptions = {
  /**
   * Called with each frame before the provider gets it. `sessionId` is what
   * ties the audio to a call: the voice mixin creates the session before it
   * knows which connection owns it, so the id minted here is the only handle
   * that spans both moments. See {@link CallTranscriber.claim}.
   */
  onAudio?: AudioTap;
};

/** What one live call has said, and how much audio it took to say it. */
type CallState = {
  /** Identifies this call from the session's creation, before `claim` names it. */
  sessionId: string;
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
 *
 * **The audio tap.** `withVoiceInput` offers no hook for raw frames, but every
 * one of them passes through `feed` on its way to the provider — so this is
 * also where a recording gets its audio, without forking the SDK. What it does
 * with it is not this class's business: it hands the bytes outward and stays
 * the decorator it is.
 */
export class CallTranscriber implements Transcriber {
  #inner: Transcriber;
  #provider: string;
  #onAudio: AudioTap | undefined;

  /** Live calls, by connection id. */
  #calls = new Map<string, CallState>();

  /**
   * The session created but not yet tied to a connection. The voice mixin
   * creates the session and waits for it to be ready *before* it calls
   * `onCallStart`, so there is one unclaimed session at a time and
   * {@link claim} is what gives it a name.
   */
  #pending: CallState | null = null;

  constructor(inner: Transcriber, provider: string, options?: CallTranscriberOptions) {
    this.#inner = inner;
    this.#provider = provider;
    this.#onAudio = options?.onAudio;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    const state: CallState = {
      sessionId: crypto.randomUUID(),
      chunks: 0,
      bytes: 0,
      interims: 0,
      finals: 0,
      trailing: "",
    };
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

    const onAudio = this.#onAudio;
    const wrapped: TranscriberSession = {
      feed(chunk) {
        state.chunks += 1;
        state.bytes += chunk.byteLength;
        if (state.chunks === 1) console.log(`[stt] first audio chunk (${chunk.byteLength} bytes)`);
        else if (state.chunks % 50 === 0) {
          console.log(`[stt] audio: ${state.chunks} chunks, ${(state.bytes / 1024).toFixed(0)}KB`);
        }
        try {
          onAudio?.(chunk, state.sessionId);
        } catch (error) {
          // Recording is the lesser of the two jobs this frame has. A broken
          // recorder must not take the call down with it.
          console.error("[rec] dropping frame:", error);
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
    if (session.updateAgentContext) {
      wrapped.updateAgentContext = (text) => session.updateAgentContext?.(text);
    }
    return wrapped;
  }

  /**
   * Tie the session just created to the connection that will hang it up.
   *
   * Returns that session's id, which is how the caller finds the recording the
   * audio has been going into, or null if no session is waiting.
   */
  claim(connectionId: string): string | null {
    if (!this.#pending) return null;
    const { sessionId } = this.#pending;
    this.#calls.set(connectionId, this.#pending);
    this.#pending = null;
    return sessionId;
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
