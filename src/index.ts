import { DurableObject, RpcTarget } from "cloudflare:workers";
import { callable, routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { RoutedAgents } from "agents/routing";
import { WebSockets } from "agents/websockets";
import { withVoiceInput } from "agents/voice";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type { UIMessage } from "ai";
import { convertToModelMessages, streamText } from "ai";
import { getModel, modelLabel } from "./model";
import { ONBOARDING_INSTRUCTIONS, WELCOME_MESSAGE } from "./onboarding";
import { MAX_QUERY } from "./shared";

/**
 * The recommended shape for "many chats per user": one top-level
 * Durable Object per chat, owned and routed to by a per-user hub.
 *
 * The hub is a plain Durable Object composed with two capabilities.
 * `RoutedAgents` gives it a durable catalog of chat IDs mapped to opaque
 * physical names, and forwards `/chats/{id}/...` requests and WebSocket
 * upgrades to the right chat. `WebSockets` serves the hub's own methods
 * to the browser, so `useAgent().stub` reaches them on either transport.
 * Each chat pushes its metadata
 * back into the hub so listing, search, and deletion never wake a chat.
 *
 * The targets must be `Agent`s: the capability relies on Agent's
 * condemnation protocol to wipe a deleted chat's storage.
 *
 * Contrast with dynamic agents (facets): a chat needs no isolation
 * boundary from its parent, does need its own alarms and placement,
 * and a user accumulates an unbounded number of them. See
 * docs/agents/sub-agents.md for the decision rule.
 */

/**
 * The host's private thread is a routed chat like any other — same class,
 * same storage, same socket — distinguished only by this flag. One chat
 * implementation, not two; `RoutedAgents` has a single namespace anyway,
 * so a separate class could not be routed alongside the group chats.
 */
type ChatKind = "host" | "group";

type ChatMeta = {
  kind: ChatKind;
  title: string | null;
  lastMessage: string | null;
  /**
   * The pushing message's own ordinal in its chat, from `messages`'
   * `AUTOINCREMENT` id. Fences out delayed or superseded pushes without
   * relying on `Date.now()` resolution: two messages sent back to back
   * (a real echo can round-trip inside one millisecond) get consecutive
   * ordinals and so never tie, unlike wall-clock timestamps.
   */
  seq: number;
};

/** Recorded once by the owning hub right after the entry is created. */
type ChatOwner = {
  eventId: string;
  chatId: string;
};

/** Runtime guards: every method here is reachable from a browser. */
function assertText(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(
      `${what} must be a non-empty string of at most ${max} characters`
    );
  }
  return value;
}
function assertChatId(value: unknown): string {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new Error("chatId must be an entry id");
  }
  return value;
}

/**
 * Our chat base class: an `AIChatAgent` with voice input composed on.
 *
 * `RoutedAgents` requires its targets to extend `Agent`, and `AIChatAgent`
 * does, so a routed chat gets message persistence, streaming and tools for
 * free rather than through a second hand-written chat path.
 */
const ChatAgent = withVoiceInput(AIChatAgent);

/** The text of a UI message, flattened for the hub's index. */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

/** One Durable Object per table, reached only through its owning event hub. */
export class GroupChat extends ChatAgent<Env> {
  /** Bounded so a long event cannot grow one table's turn without limit. */
  maxPersistedMessages = 200;

  async init(owner: ChatOwner): Promise<void> {
    await this.ctx.storage.put("owner", owner);
    // Onboarding opens itself: the participant arrives to a question rather
    // than an empty box. `persistMessages` rather than `saveMessages`,
    // because `saveMessages` drives a model turn — which would have the
    // agent answer its own greeting before anyone has typed anything.
    await this.persistMessages([
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: WELCOME_MESSAGE }]
      }
    ]);
  }

  async onChatMessage() {
    const result = streamText({
      model: getModel(this.env, { sessionAffinity: this.sessionAffinity }),
      system: ONBOARDING_INSTRUCTIONS,
      messages: await convertToModelMessages(this.messages)
    });
    return result.toUIMessageStreamResponse();
  }

  /**
   * Fires after a turn is persisted. Pushing here rather than on every frame
   * means the hub sees one update per turn, not one per streamed token.
   */
  protected async onChatResponse(): Promise<void> {
    const owner = await this.ctx.storage.get<ChatOwner>("owner");
    if (!owner) return;

    const firstFromParticipant = this.messages.find(
      (message) => message.role === "user"
    );
    const latest = this.messages.at(-1);

    try {
      const hub = this.env.ProjectHub.getByName(owner.eventId);
      await hub.recordChatActivity(owner.chatId, {
        title: firstFromParticipant
          ? messageText(firstFromParticipant).slice(0, 80)
          : null,
        lastMessage: latest ? messageText(latest).slice(0, 120) : null,
        // Message count is monotonic per chat, which is all the hub's fence
        // needs; it only ever compares a chat's pushes against its own.
        seq: this.messages.length
      });
    } catch (error) {
      console.warn("[GroupChat] owner update failed", error);
    }
  }

  /** Read by the host's cross-table view in Slice 5. */
  @callable()
  getMessages(): UIMessage[] {
    return this.messages;
  }
}

/**
 * The hub's remote interface. Prototype methods are the complete surface;
 * the WebSockets capability answers `useAgent().stub` calls against it on
 * either transport.
 */
class HubCallables extends RpcTarget {
  readonly #hub: ProjectHub;

  constructor(hub: ProjectHub) {
    super();
    this.#hub = hub;
  }

  createChat(): Promise<string> {
    return this.#hub.createChat("group");
  }

  ensureHostThread(): Promise<string> {
    return this.#hub.ensureHostThread();
  }

  describeModel(): string {
    return this.#hub.describeModel();
  }

  joinEvent(): Promise<string> {
    return this.#hub.joinEvent();
  }

  listChats() {
    return this.#hub.listChats();
  }

  searchChats(query: string) {
    return this.#hub.searchChats(assertText(query, MAX_QUERY, "query"));
  }

  deleteChat(chatId: string): Promise<boolean> {
    return this.#hub.deleteChat(assertChatId(chatId));
  }
}

/**
 * The per-user hub. It owns the set of chats, routes to them, and holds
 * the pushed metadata that the sidebar and search read.
 */
export class ProjectHub extends DurableObject<Env> {
  readonly chats = new RoutedAgents<GroupChat, ChatMeta>({
    namespace: this.env.GroupChat,
    // Claims every `/chats/{id}/...` path under this hub before any
    // other capability or onRequest sees it.
    route: "chats"
  });

  readonly webSockets = new WebSockets({
    callables: new HubCallables(this)
  });

  // RoutedAgents is installed first so a forwarded upgrade under
  // `/chats/{id}` reaches the chat; only the hub's own upgrades fall
  // through to the WebSockets capability.
  readonly lifecycle = Lifecycle.install(this)
    .use(this.chats)
    .use(this.webSockets);

  async createChat(kind: ChatKind = "group"): Promise<string> {
    const { id } = await this.chats.create({
      metadata: { kind, title: null, lastMessage: null, seq: 0 }
    });
    try {
      // get() resolves the entry to an initialized, typed stub for RPC.
      const chat = await this.chats.get(id);
      if (!chat) throw new Error(`Chat ${id} vanished during creation`);
      await chat.init({ eventId: this.lifecycle.name, chatId: id });
    } catch (error) {
      // The catalog row is uninitialized ownership without a matching
      // one-time init call, so it would never learn the chat pushes its
      // activity back into. Remove it rather than leave a chat that looks
      // created but can never appear as more than "New chat" again.
      await this.chats.delete(id);
      throw error;
    }
    return id;
  }

  /**
   * The host's thread, created on first visit to the host route. Serialized
   * so two tabs opening at once cannot leave the event with two host
   * threads — the second call sees the first one's entry.
   */
  ensureHostThread(): Promise<string> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = (await this.chats.list()).find(
        (entry) => entry.metadata?.kind === "host"
      );
      return existing ? existing.id : this.createChat("host");
    });
  }

  /** A table joining the event. One scan of the host's QR code, one chat. */
  joinEvent(): Promise<string> {
    return this.createChat("group");
  }

  /**
   * DO-RPC target for GroupChat pushes. Rejects a push whose `seq` is
   * not strictly greater than the entry's current one, so a push
   * delayed by a slow round-trip can't overwrite one that arrived first
   * — `RoutedAgents.setMetadata()` itself has no ordering concept, so
   * the fence lives here. False for a deleted chat or a superseded push.
   *
   * `blockConcurrencyWhile` makes the read-then-write atomic against
   * other concurrent calls to this method on this same hub instance —
   * without it, two pushes could both read the same "current" value
   * before either writes, and the fence would compare against a value
   * that's already stale by the time the later one applies.
   */
  recordChatActivity(
    chatId: string,
    meta: Omit<ChatMeta, "kind">
  ): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = (await this.chats.list()).find(
        (entry) => entry.id === chatId
      );
      if (!current || (current.metadata?.seq ?? 0) >= meta.seq) {
        return false;
      }
      // `kind` is the hub's to assign, so carry it across rather than let
      // a chat's push — which cannot know it — erase it.
      return this.chats.setMetadata(chatId, {
        ...meta,
        kind: current.metadata?.kind ?? "group"
      });
    });
  }

  /** Most recent activity first; reads only this DO. */
  listChats() {
    return this.chats.list();
  }

  /** Cross-chat search over the pushed metadata; no chat wakes up. */
  async searchChats(query: string) {
    const needle = query.toLowerCase();
    return (await this.chats.list()).filter(({ metadata }) =>
      [metadata?.title, metadata?.lastMessage].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    );
  }

  /** Destroys the chat's own storage and removes it from the catalog. */
  deleteChat(chatId: string): Promise<boolean> {
    return this.chats.delete(chatId);
  }

  /** Which provider chats will actually use — the demo gets asked this. */
  @callable()
  describeModel(): string {
    return modelLabel(this.env);
  }

  /** Plain HTTP view of the catalog, for curl. */
  async onRequest(): Promise<Response> {
    return Response.json({
      event: this.lifecycle.name,
      model: modelLabel(this.env),
      chats: await this.chats.list()
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Routes both /agents/project-hub/{user} and the forwarded
    // /agents/project-hub/{user}/chats/{id}/... paths: RoutedAgents claims the
    // latter from inside the hub once the request reaches it.
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
