import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Input, PoweredByCloudflare, Text } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useHub } from "../hooks/useHub";
import type { ChatEntry } from "../types";
import { ChatPane } from "./ChatPane";
import { JoinCode } from "./JoinCode";
import { ModeToggle } from "./ModeToggle";
import { ShareLink } from "./ShareLink";

/**
 * The host's console: their own private thread, the QR code that spawns
 * conversations, and the conversations that have joined. Listing and search
 * read only the hub, so no conversation's Durable Object wakes for the sidebar.
 */
export function HostView({ eventId }: { eventId: string }) {
  const refresh = useRef<() => void>(undefined);
  const { hub, api } = useHub(eventId, () => refresh.current?.());
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const [hostChatId, setHostChatId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const refreshChats = useCallback(async () => {
    const needle = query.trim();
    setChats(needle === "" ? await api.listChats() : await api.searchChats(needle));
  }, [api, query]);
  useEffect(() => {
    refresh.current = () => void refreshChats();
  });

  useEffect(() => {
    if (!hub.identified) return;
    void (async () => {
      setHostChatId(await api.ensureHostThread());
      setModel(await api.describeModel());
      await refreshChats();
    })();
  }, [api, hub.identified, refreshChats]);

  const createChat = useCallback(async () => {
    setActiveId(await api.createChat());
    await refreshChats();
  }, [api, refreshChats]);

  const deleteChat = useCallback(
    async (chatId: string) => {
      await api.deleteChat(chatId);
      if (activeId === chatId) setActiveId(null);
      await refreshChats();
    },
    [activeId, api, refreshChats],
  );

  // The host's own thread is in the catalog like any other chat; it just
  // does not belong in the list of conversations.
  const conversations = chats.filter((chat) => chat.metadata?.kind !== "host");

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Text bold>Host console</Text>
          <Badge variant="secondary">event {eventId}</Badge>
          <Badge variant="secondary">{conversations.length} conversations</Badge>
          {model && <Badge variant="secondary">{model}</Badge>}
        </div>
        <ModeToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 flex-col border-r border-kumo-line">
          <div className="flex items-center gap-2 p-3">
            <Input
              value={query}
              aria-label="Search all conversations"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search all conversations…"
              className="flex-1"
            />
            <Button
              variant="primary"
              shape="square"
              aria-label="New chat"
              onClick={() => void createChat()}
              icon={<PlusIcon size={16} />}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {hostChatId && (
              <button
                type="button"
                onClick={() => setActiveId(hostChatId)}
                className={`flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-kumo-elevated ${
                  activeId === hostChatId ? "bg-kumo-elevated" : ""
                }`}
              >
                <Text size="sm" bold>
                  Your thread
                </Text>
                <Text size="xs" variant="secondary">
                  host
                </Text>
              </button>
            )}
            {conversations.length === 0 ? (
              <div className="p-4">
                <Text size="sm" variant="secondary">
                  {query
                    ? "No conversations match — the search ran over the hub's index only."
                    : "No conversations yet. Each scan of the code creates one, in its own Durable Object."}
                </Text>
              </div>
            ) : (
              conversations.map((chat) => (
                <div
                  key={chat.id}
                  className={`group flex w-full items-center justify-between pr-2 hover:bg-kumo-elevated ${
                    activeId === chat.id ? "bg-kumo-elevated" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(chat.id)}
                    aria-label={`Open ${chat.metadata?.title ?? "new conversation"}`}
                    className="min-w-0 flex-1 px-4 py-3 text-left"
                  >
                    <div className="truncate">
                      <Text size="sm" bold>
                        {chat.metadata?.title ?? "New conversation"}
                      </Text>
                    </div>
                    <div className="truncate">
                      <Text size="xs" variant="secondary">
                        {chat.metadata?.lastMessage ?? "No messages yet"}
                      </Text>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Delete conversation"
                    className="opacity-0 focus:opacity-100 group-hover:opacity-100"
                    onClick={() => void deleteChat(chat.id)}
                    icon={<TrashIcon size={14} />}
                  />
                </div>
              ))
            )}
          </div>
          <div className="border-t border-kumo-line p-3">
            <PoweredByCloudflare />
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeId ? (
            <ChatPane
              key={activeId}
              eventId={eventId}
              chatId={activeId}
              onActivity={() => void refreshChats()}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <JoinCode eventId={eventId} />
            </div>
          )}
        </main>

        {activeId && (
          <aside className="flex w-64 flex-col overflow-y-auto border-l border-kumo-line">
            <JoinCode eventId={eventId} />
            {/* The host's own thread is nobody else's to open. */}
            {activeId !== hostChatId && (
              <ShareLink key={activeId} eventId={eventId} chatId={activeId} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
