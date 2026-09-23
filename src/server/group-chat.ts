import { callable, type Connection } from "agents";
import { withVoiceInput } from "agents/voice";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type { UIMessage } from "ai";
import { convertToModelMessages, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { getModel } from "./model";
import { getTranscriber } from "./stt";
import { Recorder } from "./recording";
import { ONBOARDING_INSTRUCTIONS, WELCOME_MESSAGE } from "./prompts/onboarding";
import { HOST_INSTRUCTIONS, HOST_WELCOME_MESSAGE } from "./prompts/host";
import { isCallMarker } from "../shared";
import type { ChatMeta, ChatOwner, ConversationState, RecordingMeta } from "../types";

/** How much of a call's transcript the hub keeps for cross-conversation reads. */
const TRANSCRIPT_EXCERPT = 600;

/**
 * How long to wait before flushing a recording nobody has hung up.
 *
 * A clean hang-up flushes through `onCallEnd`, and a dropped socket reaches the
 * same hook, so this only catches a call whose audio stopped arriving without
 * either — a wedged client, a provider that went quiet. It exists so the last
 * few seconds of such a call still reach R2 rather than sitting staged forever.
 */
const STALLED_FLUSH_SECONDS = 30;

/** A conversation as the host's tools see it: the hub's pushed metadata. */
function describeConversations(entries: readonly { id: string; metadata: ChatMeta | null }[]) {
  return entries
    .filter((entry) => entry.metadata?.kind !== "host")
    .map((entry, index) => ({
      conversation: index + 1,
      title: entry.metadata?.title ?? null,
      lastMessage: entry.metadata?.lastMessage ?? null,
      recentCallTranscript: entry.metadata?.transcript ?? null,
    }));
}

/**
 * Our chat base class: an `AIChatAgent` with voice input composed on.
 *
 * `RoutedAgents` requires its targets to extend `Agent`, and `AIChatAgent`
 * does, so a routed chat gets message persistence, streaming and tools for
 * free rather than through a second hand-written chat path.
 */
const ChatAgent = withVoiceInput(AIChatAgent, {
  // Voice diagnostics are off unless asked for. With this on, the mixin sends
  // `call.ended` (with its `reason`), `stt.*` and per-turn events down the
  // voice socket, and the client prints them to the BROWSER console — they
  // never reach the wrangler console.
  diagnostics: { browserConsole: true },
});

/** The text of a UI message, flattened for the hub's index. */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

/** One Durable Object per conversation, reached only through its event hub. */
export class GroupChat extends ChatAgent<Env, ConversationState> {
  initialState: ConversationState = { name: null, participants: null };

  /** Bounded so a long event cannot grow one conversation's turn unbounded. */
  maxPersistedMessages = 200;

  /**
   * Call audio, staged in this conversation's own SQLite and flushed to R2.
   *
   * Constructed before `transcriber` on purpose: the transcriber's audio tap
   * calls straight into it, and a field initialiser cannot reach one declared
   * below it.
   */
  #recorder = new Recorder(this.ctx.storage.sql, this.env.RECORDINGS);

  transcriber = getTranscriber(this.env, {
    onAudio: (chunk, sessionId) => this.#onAudio(chunk, sessionId),
  });

  /**
   * This conversation's id, read once `onCallStart` has it. Held so the audio
   * path never has to await storage: a read closes the input gate, and this one
   * would be on the hot path ten times a second.
   */
  #chatId: string | null = null;

  /**
   * Utterances of calls in progress, per connection. In memory: an open call
   * holds its socket open, so the object stays awake for the call's duration.
   */
  #calls = new Map<string, string[]>();

  /** The recording each live call is writing into, by connection. */
  #recording = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup and nothing else. A throw in here aborts and resets the
    // whole object, on every wake, until a fix ships — so the block stays as
    // small as the tables it creates.
    ctx.blockConcurrencyWhile(async () => {
      this.#recorder.ensureSchema();
    });
  }

  async init(owner: ChatOwner): Promise<void> {
    await this.ctx.storage.put("owner", owner);
    // The host's thread just says hello. Onboarding opens itself instead:
    // the participant arrives to a question rather than an empty box. `persistMessages` rather than `saveMessages`,
    // because `saveMessages` drives a model turn — which would have the
    // agent answer its own greeting before anyone has typed anything.
    await this.persistMessages([
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [
          {
            type: "text",
            text: owner.kind === "host" ? HOST_WELCOME_MESSAGE : WELCOME_MESSAGE,
          },
        ],
      },
    ]);
  }

  async onChatMessage() {
    const owner = await this.ctx.storage.get<ChatOwner>("owner");
    const isHost = owner?.kind === "host";
    const result = streamText({
      model: getModel(this.env, { sessionAffinity: this.sessionAffinity }),
      system: isHost ? HOST_INSTRUCTIONS : ONBOARDING_INSTRUCTIONS,
      messages: await convertToModelMessages(this.messages),
      tools: isHost && owner ? this.#hostTools(owner.eventId) : this.#conversationTools(),
      // Room for a tool call and the answer that reads its result.
      stopWhen: stepCountIs(5),
    });
    return result.toUIMessageStreamResponse();
  }

  /** A conversation names itself during onboarding; the host sees the name. */
  #conversationTools() {
    return {
      setConversationName: tool({
        description:
          "Set this conversation's name, so the host can tell the conversations apart. Call it as soon as the participants say what to call theirs.",
        inputSchema: jsonSchema<{ name: string }>({
          type: "object",
          properties: { name: { type: "string", maxLength: 60 } },
          required: ["name"],
        }),
        execute: async ({ name }) => {
          const trimmed = name.trim().slice(0, 60);
          if (!trimmed) return { ok: false, error: "name is empty" };
          this.setState({ ...this.state, name: trimmed });
          await this.#pushToHub();
          return { ok: true, name: trimmed };
        },
      }),
      setParticipantCount: tool({
        description:
          "Record how many people are taking part in this conversation: 1 if they are recording on their own or say they are not a group, otherwise the number they give.",
        inputSchema: jsonSchema<{ count: number }>({
          type: "object",
          properties: { count: { type: "integer", minimum: 1, maximum: 100 } },
          required: ["count"],
        }),
        execute: async ({ count }) => {
          const participants = Math.round(count);
          if (!(participants >= 1 && participants <= 100)) {
            return { ok: false, error: "count must be between 1 and 100" };
          }
          this.setState({ ...this.state, participants });
          return { ok: true, participants };
        },
      }),
    };
  }

  /**
   * The host's view across the room. Both tools read only the hub's pushed
   * metadata, so asking "what's happening?" wakes no conversation.
   */
  #hostTools(eventId: string) {
    const hub = this.env.ProjectHub.getByName(eventId);
    return {
      listConversations: tool({
        description:
          "List every conversation in the event with its latest message and the tail of its most recent voice call.",
        inputSchema: jsonSchema<Record<string, never>>({
          type: "object",
          properties: {},
        }),
        execute: async () => describeConversations(await hub.listChats()),
      }),
      searchConversations: tool({
        description:
          "Find conversations whose title, latest message or call transcript mentions a word or phrase.",
        inputSchema: jsonSchema<{ query: string }>({
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        }),
        execute: async ({ query }) => describeConversations(await hub.searchChats(query)),
      }),
    };
  }

  async onCallStart(connection: Connection): Promise<void> {
    console.log(`[call] start ${connection.id.slice(0, 8)}`);
    // The mixin has already created the transcriber session and waited for it
    // to be ready; this is where it gets a name, so hang-up can go looking for
    // what the call heard.
    const sessionId = this.transcriber.claim(connection.id);
    this.#calls.set(connection.id, []);
    if (!sessionId) return;

    const owner = await this.ctx.storage.get<ChatOwner>("owner");
    this.#chatId = owner?.chatId ?? connection.id;

    // The mixin calls this hook again when a call survives an eviction, so
    // everything below has to be safe to run twice. `open` returning the
    // session's existing recording is the guard: a second one would split one
    // call into two voice notes, and the transcript would point at the wrong
    // half. (The utterances in `#calls` are not so lucky — they are reset just
    // above, which is a pre-existing hole in what a resumed call remembers.)
    const before = this.#recorder.forSession(sessionId);
    const recordingId = this.#recorder.open(sessionId, connection.id, this.#chatId);
    if (before) return;

    this.#recording.set(connection.id, recordingId);
    await this.schedule(STALLED_FLUSH_SECONDS, "flushStalledRecordings");

    // The voice note goes in as the call opens, not when it ends: it is what
    // makes a call in progress visible in the thread, and it fills in — length
    // and waveform both — as people speak. It carries a text part because the
    // AI SDK's persistence and `convertToModelMessages` both expect one, but
    // the client renders the audio, not the words.
    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        metadata: { kind: "call-started", recordingId },
        parts: [{ type: "text", text: "Voice call started" }],
      },
    ]);
  }

  /**
   * Stage one frame of call audio. **On the hot path**, ten times a second.
   *
   * Everything here is synchronous — one `INSERT` — and the R2 write is started
   * without being awaited, because this runs inside the transcriber's `feed`
   * and the voice pipeline must not wait on object storage to hear the next
   * word. A frame that arrives before `onCallStart` has opened the recording is
   * dropped rather than opening one this cannot name.
   */
  #onAudio(chunk: ArrayBuffer, sessionId: string): void {
    const recordingId = this.#recorder.forSession(sessionId);
    if (!recordingId) return;
    if (this.#recorder.append(recordingId, chunk)) {
      void this.#recorder.flush(recordingId);
    }
  }

  /** Flush a call whose audio stopped arriving without anyone hanging up. */
  async flushStalledRecordings(): Promise<void> {
    const open = this.#recorder.openRecordings();
    if (open.length === 0) return;
    for (const recordingId of open) await this.#recorder.flush(recordingId);
    await this.schedule(STALLED_FLUSH_SECONDS, "flushStalledRecordings");
  }

  /** The recording behind a call, for the browser's voice note. */
  @callable()
  describeRecording(recordingId: string): RecordingMeta | null {
    const summary = this.#recorder.describe(recordingId);
    if (!summary) return null;
    // Segment keys stay here. The route reads them from the same object, and
    // nothing the browser does needs to know where the bytes live.
    return {
      ended: summary.ended,
      durationSec: summary.durationSec,
      waveform: summary.waveform,
    };
  }

  /** Metadata and segment keys, for the playback route. */
  recordingManifest(recordingId: string) {
    return this.#recorder.describe(recordingId);
  }

  /** Each finished utterance extends the call and refreshes the host's view. */
  async onTranscript(text: string, connection: Connection): Promise<void> {
    console.log(`[call] transcript ${connection.id.slice(0, 8)}: ${JSON.stringify(text)}`);
    const utterances = this.#calls.get(connection.id) ?? [];
    utterances.push(text);
    this.#calls.set(connection.id, utterances);
    await this.ctx.storage.put("transcript", utterances.join(" ").slice(-TRANSCRIPT_EXCERPT));
    await this.#pushToHub();
  }

  /**
   * Ending the call leaves the transcript in the thread, as a message from the
   * conversation. Persisted without a model turn: the agent should not answer a
   * transcript unprompted, but it is now in the context for the next question.
   */
  async onCallEnd(connection: Connection): Promise<void> {
    const utterances = this.#calls.get(connection.id) ?? [];
    this.#calls.delete(connection.id);

    // Close the recording first, so the message that announces the call is
    // over cannot land before the audio it points at is all in R2.
    const recordingId = this.#recording.get(connection.id) ?? null;
    this.#recording.delete(connection.id);
    const recording = recordingId ? await this.#recorder.end(recordingId) : null;
    if (recording) {
      console.log(
        `[rec] ${recordingId}: ${recording.segments.length} segments, ${(recording.totalBytes / 1024).toFixed(0)}KB, ${recording.durationSec.toFixed(1)}s`,
      );
    }

    // Deepgram only finalises an utterance once its endpointer hears a pause,
    // and in a noisy room — a fan, a busy venue — that pause may never come.
    // Whatever was said since the last final is still sitting in the interim
    // text, so take it rather than lose the end of what someone said.
    const trailing = this.transcriber.takeTrailingInterim(connection.id);
    this.transcriber.release(connection.id);
    if (trailing) {
      console.log(
        `[call] end ${connection.id.slice(0, 8)}: trailing interim ${JSON.stringify(trailing)}`,
      );
      utterances.push(trailing);
      // Keep the host's excerpt in step: `onTranscript` never saw this text.
      await this.ctx.storage.put("transcript", utterances.join(" ").slice(-TRANSCRIPT_EXCERPT));
    }

    console.log(`[call] end ${connection.id.slice(0, 8)}, ${utterances.length} utterances`);
    if (utterances.length === 0) {
      // Silence here is what made this bug invisible: a failed transcriber ends
      // the call through the same hook as a clean hang-up.
      console.warn(`[call] end ${connection.id.slice(0, 8)}: NOTHING TRANSCRIBED`);
      if (!recording?.totalBytes) return;
      // There is still audio, though, and it is worth keeping — a call the
      // provider could not hear is exactly the one someone will want to play
      // back. The transcript stays empty and the voice note carries the call.
    }

    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        metadata: {
          kind: "voice-call",
          ...(recordingId ? { recordingId, durationSec: recording?.durationSec ?? 0 } : {}),
        },
        parts: [{ type: "text", text: `Voice call transcript:\n${utterances.join(" ")}` }],
      },
    ]);
    await this.#pushToHub();
  }

  /**
   * Fires after a turn is persisted. Pushing here rather than on every frame
   * means the hub sees one update per turn, not one per streamed token.
   */
  protected async onChatResponse(): Promise<void> {
    await this.#pushToHub();
  }

  /** Refresh this conversation's entry, so listing never wakes a chat. */
  async #pushToHub(): Promise<void> {
    const owner = await this.ctx.storage.get<ChatOwner>("owner");
    if (!owner) return;

    const seq = ((await this.ctx.storage.get<number>("pushSeq")) ?? 0) + 1;
    await this.ctx.storage.put("pushSeq", seq);

    const firstFromParticipant = this.messages.find(
      (message) => message.role === "user" && !isCallMarker(message.metadata),
    );
    const latest = this.messages.at(-1);

    try {
      const hub = this.env.ProjectHub.getByName(owner.eventId);
      await hub.recordChatActivity(owner.chatId, {
        // The name the conversation chose, if any; until then, its first words.
        title:
          this.state.name ??
          (firstFromParticipant ? messageText(firstFromParticipant).slice(0, 80) : null),
        lastMessage: latest ? messageText(latest).slice(0, 120) : null,
        transcript: (await this.ctx.storage.get<string>("transcript")) ?? null,
        seq,
      });
    } catch (error) {
      console.warn("[GroupChat] owner update failed", error);
    }
  }

  /** Read by the host's cross-conversation view in Slice 5. */
  @callable()
  getMessages(): UIMessage[] {
    return this.messages;
  }
}
