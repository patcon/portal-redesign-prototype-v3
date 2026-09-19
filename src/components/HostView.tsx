import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CrownIcon, PhoneIcon, Share2Icon } from "lucide-react";
import { Badge } from "@/components/ui/shadcn/badge";
import { Button } from "@/components/ui/shadcn/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/shadcn/sheet";
import type { ChatUser } from "@/components/ui/chatcn/types";
import { useHub } from "../hooks/useHub";
import type { ChatEntry, ConversationState } from "../types";
import { describeParticipants, toConversationRows } from "./adapt";
import { ChatPane } from "./ChatPane";
import { BackToList, ConversationListItem, ConversationsShell } from "./ConversationsShell";
import { JoinCode } from "./JoinCode";
import { ModeToggle } from "./ModeToggle";
import { ShareLink } from "./ShareLink";

/** The host's own thread, named the same way in the list and in its header. */
const HOST_THREAD_TITLE = "Host thread";

/** The host is one identity across every thread they open in the console. */
const HOST: ChatUser = { id: "host", name: "Host" };

/**
 * The host's console: their own private thread, the QR code that spawns
 * conversations, and the conversations that have joined. Listing and search
 * read only the hub, so no conversation's Durable Object wakes for the sidebar.
 *
 * Everything below is data; `ConversationsShell` owns the layout.
 */
export function HostView({ eventId }: { eventId: string }) {
  const refresh = useRef<() => void>(undefined);
  const { hub, api } = useHub(eventId, () => refresh.current?.());
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const [hostChatId, setHostChatId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  // The open conversation's synced state, tagged with whose it is. Tagging rather
  // than clearing on selection: `ChatPane` pushes state from a socket, so a stale
  // value would otherwise caption the next conversation until its own state landed.
  const [state, setState] = useState<{ chatId: string; state: ConversationState } | null>(null);

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
  const conversations = useMemo(
    () => chats.filter((chat) => chat.metadata?.kind !== "host"),
    [chats],
  );
  const rows = useMemo(() => toConversationRows(conversations), [conversations]);

  const hostEntry = useMemo(() => chats.find((chat) => chat.metadata?.kind === "host"), [chats]);

  const isHostThread = activeId !== null && activeId === hostChatId;
  const activeTitle = isHostThread
    ? HOST_THREAD_TITLE
    : (rows.find((row) => row.id === activeId)?.title ?? "Conversation");
  // Who is in the conversation, on how many devices — the same caption its own
  // device shows itself. The host's thread has no participants to count.
  const activeSubtitle =
    isHostThread || activeId === null
      ? undefined
      : describeParticipants(state?.chatId === activeId ? state.state : null);

  return (
    <ConversationsShell
      currentUser={HOST}
      title="Conversations"
      rows={rows}
      activeId={activeId}
      onSelect={setActiveId}
      onCreate={() => void createChat()}
      onDelete={(chatId) => void deleteChat(chatId)}
      query={query}
      onQueryChange={setQuery}
      emptyListMessage={
        query
          ? "No conversations match — the search ran over the hub's index only."
          : "No conversations yet. Each scan of the code creates one, in its own Durable Object."
      }
      headerActions={
        <>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Share this event">
                <Share2Icon className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="gap-6 overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Invite people to this event</SheetTitle>
                <SheetDescription>
                  Every scan of this code starts a new conversation in its own Durable Object.
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-6 px-4 pb-6">
                <JoinCode eventId={eventId} />
                {/* The host's own thread is nobody else's to open. */}
                {activeId && !isHostThread && (
                  <ShareLink key={activeId} eventId={eventId} chatId={activeId} />
                )}
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">event {eventId}</Badge>
                  <Badge variant="secondary">{conversations.length} conversations</Badge>
                  {model && <Badge variant="secondary">{model}</Badge>}
                </div>
              </div>
            </SheetContent>
          </Sheet>
          <ModeToggle />
        </>
      }
      pinnedRow={
        hostChatId && (
          // The same row as every conversation below it — one list, with the host's
          // thread held at the top of it — except for the avatar: an initial there
          // would read as somebody's name rather than as the host's own thread.
          <ConversationListItem
            row={{
              id: hostChatId,
              title: HOST_THREAD_TITLE,
              lastMessage: hostEntry?.metadata?.lastMessage ?? "Ask about the room",
            }}
            icon={<CrownIcon className="size-4" />}
            isActive={isHostThread}
            onSelect={() => setActiveId(hostChatId)}
          />
        )
      }
    >
      {activeId === null ? (
        // Only reachable at `md` and up: below it the sidebar has the screen to
        // itself until something is selected.
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-[15px] font-semibold text-[var(--chat-text-primary)]">
            No conversation selected
          </p>
          <p className="max-w-sm text-[13px] text-[var(--chat-text-secondary)]">
            Pick one from the list, or share the event's code to start another.
          </p>
        </div>
      ) : (
        <ChatPane
          key={activeId}
          eventId={eventId}
          chatId={activeId}
          currentUser={HOST}
          title={activeTitle}
          subtitle={activeSubtitle}
          onState={(next) => setState({ chatId: activeId, state: next })}
          avatar={<BackToList onBack={() => setActiveId(null)} />}
          onActivity={() => void refreshChats()}
          // The host's thread is the host briefing themselves on the room; a
          // call belongs in the conversations, where there are people talking.
          callable={!isHostThread}
          actions={({ callable, inCall, startCall }) => (
            <Button
              variant="ghost"
              size="icon"
              // Disabled rather than dropped, so the host's thread reads as a
              // thread that does not take calls instead of one that mislaid
              // its phone button.
              disabled={!callable}
              aria-label={inCall ? "Return to call" : "Start call"}
              onClick={startCall}
            >
              <PhoneIcon className="size-4" />
            </Button>
          )}
        />
      )}
    </ConversationsShell>
  );
}
