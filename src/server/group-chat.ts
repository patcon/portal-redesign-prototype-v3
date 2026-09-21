import { callable, type Connection } from "agents";
import { withVoiceInput } from "agents/voice";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type { UIMessage } from "ai";
import { convertToModelMessages, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { getModel } from "./model";
import { CallLog } from "./call-log";
import { getTranscriber } from "./stt";
import { ONBOARDING_INSTRUCTIONS, WELCOME_MESSAGE } from "./prompts/onboarding";
import { HOST_INSTRUCTIONS, HOST_WELCOME_MESSAGE } from "./prompts/host";
import type { ChatMeta, ChatOwner, ConversationState } from "../types";

/** How much of a call's transcript the hub keeps for cross-conversation reads. */
const TRANSCRIPT_EXCERPT = 600;

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

  transcriber = getTranscriber(this.env);

  /**
   * Utterances of calls in progress, per connection. Kept in storage, not in
   * memory: an open socket does not keep this object resident, so a call can
   * outlive the instance that started it.
   */
  #calls = new CallLog(this.ctx.storage);

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

  /**
   * `options.abortSignal` is forwarded to the model call, as the Agents SDK
   * chat docs require: without it a client that disconnects or hits stop
   * leaves the provider generating a turn nobody will read.
   */
  async onChatMessage(
    // Derived from the base rather than named: the linked `agents` checkout
    // resolves its own copy of `ai`, so spelling these types out here pits two
    // versions of `GenerateTextOnFinishCallback` against each other.
    ...args: Parameters<AIChatAgent<Env, ConversationState>["onChatMessage"]>
  ) {
    const abortSignal = args[1]?.abortSignal;
    const owner = await this.ctx.storage.get<ChatOwner>("owner");
    const isHost = owner?.kind === "host";
    const result = streamText({
      model: getModel(this.env, { sessionAffinity: this.sessionAffinity }),
      system: isHost ? HOST_INSTRUCTIONS : ONBOARDING_INSTRUCTIONS,
      messages: await convertToModelMessages(this.messages),
      tools: isHost && owner ? this.#hostTools(owner.eventId) : this.#conversationTools(),
      // Room for a tool call and the answer that reads its result.
      stopWhen: stepCountIs(5),
      abortSignal,
      // `streamText` does not throw on a provider failure — without this the
      // turn ends quietly and the thread just never gains an answer.
      onError: ({ error }) => console.error("[GroupChat] model turn failed", error),
    });
    return result.toUIMessageStreamResponse({
      // The default masks every failure as "An error occurred", which hides
      // the one thing worth reading. This is a prototype behind a join code,
      // so the real message is more use in the browser than a generic one.
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
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

  /**
   * Also runs when a call is resumed on a rebuilt instance, which is why the
   * log is opened idempotently rather than reset.
   */
  async onCallStart(connection: Connection): Promise<void> {
    console.log(`[call] start ${connection.id.slice(0, 8)}`);
    // The mixin has already created the transcriber session and waited for it
    // to be ready; this is where it gets a name, so hang-up can go looking for
    // what the call heard.
    this.transcriber.claim(connection.id);
    await this.#calls.start(connection.id);
  }

  /** Each finished utterance extends the call and refreshes the host's view. */
  async onTranscript(text: string, connection: Connection): Promise<void> {
    console.log(`[call] transcript ${connection.id.slice(0, 8)}: ${JSON.stringify(text)}`);
    const utterances = await this.#calls.append(connection.id, text);
    await this.ctx.storage.put("transcript", utterances.join(" ").slice(-TRANSCRIPT_EXCERPT));
    await this.#pushToHub();
  }

  /**
   * Ending the call leaves the transcript in the thread, as a message from the
   * conversation. Persisted without a model turn: the agent should not answer a
   * transcript unprompted, but it is now in the context for the next question.
   */
  async onCallEnd(connection: Connection): Promise<void> {
    const utterances = await this.#calls.end(connection.id);

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
      console.warn(
        `[call] end ${connection.id.slice(0, 8)}: NOTHING TRANSCRIBED — no message written`,
      );
      return;
    }

    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        metadata: { kind: "voice-call" },
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
      (message) =>
        message.role === "user" &&
        (message.metadata as { kind?: string } | undefined)?.kind !== "voice-call",
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
