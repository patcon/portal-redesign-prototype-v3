import { DurableObject, RpcTarget } from "cloudflare:workers";
import { callable } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { RoutedAgents } from "agents/routing";
import { WebSockets } from "agents/websockets";
import { modelLabel } from "./model";
import { sttLabel } from "./stt";
import { CHATS_CHANGED, MAX_QUERY } from "../shared";
import type { ChatKind, ChatMeta } from "../types";
import type { GroupChat } from "./group-chat";
import { assertChatId, assertText } from "./validate";

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
      metadata: {
        kind,
        title: null,
        lastMessage: null,
        transcript: null,
        seq: 0
      }
    });
    try {
      // get() resolves the entry to an initialized, typed stub for RPC.
      const chat = await this.chats.get(id);
      if (!chat) throw new Error(`Chat ${id} vanished during creation`);
      await chat.init({ eventId: this.lifecycle.name, chatId: id, kind });
    } catch (error) {
      // The catalog row is uninitialized ownership without a matching
      // one-time init call, so it would never learn the chat pushes its
      // activity back into. Remove it rather than leave a chat that looks
      // created but can never appear as more than "New chat" again.
      await this.chats.delete(id);
      throw error;
    }
    this.#announceChatsChanged();
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

  /** A conversation joining the event. One scan of the host's QR code, one chat. */
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
      const updated = await this.chats.setMetadata(chatId, {
        ...meta,
        kind: current.metadata?.kind ?? "group"
      });
      if (updated) this.#announceChatsChanged();
      return updated;
    });
  }

  /**
   * Tell every open host console to re-read the catalog. A nudge rather than
   * the data: the console already knows how to list and search, and a conversation
   * renaming itself should not need a second path to reach the sidebar.
   */
  #announceChatsChanged(): void {
    const frame = JSON.stringify({ type: CHATS_CHANGED });
    for (const connection of this.webSockets.getConnections()) {
      connection.send(frame);
    }
  }

  /** Most recent activity first; reads only this DO. */
  listChats() {
    return this.chats.list();
  }

  /** Cross-chat search over the pushed metadata; no chat wakes up. */
  async searchChats(query: string) {
    const needle = query.toLowerCase();
    return (await this.chats.list()).filter(({ metadata }) =>
      [metadata?.title, metadata?.lastMessage, metadata?.transcript].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    );
  }

  /** Destroys the chat's own storage and removes it from the catalog. */
  async deleteChat(chatId: string): Promise<boolean> {
    const deleted = await this.chats.delete(chatId);
    if (deleted) this.#announceChatsChanged();
    return deleted;
  }

  /** Which provider chats will actually use — the demo gets asked this. */
  @callable()
  describeModel(): string {
    return `${modelLabel(this.env)} · STT ${sttLabel(this.env)}`;
  }

  /** Plain HTTP view of the catalog, for curl. */
  async onRequest(): Promise<Response> {
    return Response.json({
      event: this.lifecycle.name,
      model: modelLabel(this.env),
      stt: sttLabel(this.env),
      chats: await this.chats.list()
    });
  }
}
