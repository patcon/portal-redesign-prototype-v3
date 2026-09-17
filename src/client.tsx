import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ChatCircleIcon,
  MicrophoneIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { RoutedAgentEntry } from "agents/routing";
import qrcode from "qrcode-generator";
import { hrefFor, navigate, parseRoute } from "./router";
import type { Route } from "./router";
import { MAX_TEXT } from "./shared";
import { useCall } from "./voice";
import "./styles.css";

type ChatEntry = RoutedAgentEntry<{
  kind: "host" | "group";
  title: string | null;
  lastMessage: string | null;
  transcript: string | null;
  seq: number;
}>;

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

/** The hub's RpcTarget, as seen from the browser. */
type HubApi = {
  createChat(): Promise<string>;
  ensureHostThread(): Promise<string>;
  describeModel(): Promise<string>;
  joinEvent(): Promise<string>;
  listChats(): Promise<ChatEntry[]>;
  searchChats(query: string): Promise<ChatEntry[]>;
  deleteChat(chatId: string): Promise<boolean>;
};

function useHub(eventId: string) {
  const hub = useAgent({ agent: "project-hub", name: eventId });
  return { hub, api: hub.stub as HubApi };
}

function useRoute(): Route | null {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return route;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

/**
 * Rendered from `location.origin`, so the code encodes whatever address the
 * host actually opened the console on. Serve on the LAN address and the QR
 * points at the LAN address; there is no configured hostname to get wrong.
 */
function JoinCode({ eventId }: { eventId: string }) {
  const joinUrl = `${location.origin}${hrefFor({ name: "join", eventId })}`;
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(joinUrl);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [joinUrl]);

  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <Text size="sm" variant="secondary">
        Scan to join this event
      </Text>
      <div
        className="w-48 bg-white p-2"
        // Generated from our own join URL, not from anything a user typed.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <Text size="xs" variant="secondary">
        {joinUrl}
      </Text>
    </div>
  );
}

function ChatPane({
  eventId,
  chatId,
  onActivity,
  onName
}: {
  eventId: string;
  chatId: string;
  onActivity?: () => void;
  onName?: (name: string | null) => void;
}) {
  // One WebSocket per open chat. The upgrade goes through the event hub,
  // which resolves the chat ID; the chat's own DO then owns the socket,
  // so the hub is not on the message path.
  const basePath = `agents/project-hub/${encodeURIComponent(eventId)}/chats/${encodeURIComponent(chatId)}`;
  const agent = useAgent<{ name: string | null }>({
    agent: "group-chat",
    // Ignored for the URL, which `basePath` sets, but `useAgentChat` keys its
    // message cache by agent and name. Without it every routed chat is
    // "default", and switching chats keeps showing the first one opened.
    name: chatId,
    basePath,
    onStateUpdate: (state) => onName?.(state.name)
  });
  const call = useCall(basePath);
  const { messages, sendMessage, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });
  const [draft, setDraft] = useState("");
  const isStreaming = status === "streaming" || status === "submitted";
  const tail = useRef<HTMLDivElement>(null);

  // The host's sidebar reads pushed metadata, which only lands once a turn
  // finishes — so refresh on the streaming edge, not on every token. Held in
  // a ref: a fresh callback each render would otherwise re-fire this effect,
  // refresh the list, re-render, and loop for as long as a chat is open.
  const activity = useRef(onActivity);
  activity.current = onActivity;
  useEffect(() => {
    if (!isStreaming) activity.current?.();
  }, [isStreaming]);

  useEffect(() => {
    tail.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  const send = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = draft.trim().slice(0, MAX_TEXT);
      if (!text || isStreaming) return;
      setDraft("");
      sendMessage({ role: "user", parts: [{ type: "text", text }] });
    },
    [draft, isStreaming, sendMessage]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <Empty
            icon={<ChatCircleIcon size={24} />}
            title="Connecting…"
            description="This table's Durable Object is waking up."
          />
        ) : (
          messages.map((message) => {
            const text = message.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
            if (!text) return null;
            const isCall =
              (message.metadata as { kind?: string } | undefined)?.kind ===
              "voice-call";
            return (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <Surface
                  className={`max-w-[80%] rounded-lg px-3 py-2 whitespace-pre-wrap ${
                    message.role === "user" ? "bg-kumo-brand/10" : ""
                  }`}
                >
                  {isCall ? (
                    <>
                      <Text size="xs" variant="secondary">
                        🎙️ Voice call
                      </Text>
                      <Text size="sm">
                        {text.replace(/^Voice call transcript:\n/, "")}
                      </Text>
                    </>
                  ) : (
                    <Text size="sm">{text}</Text>
                  )}
                </Surface>
              </div>
            );
          })
        )}
        <div ref={tail} />
      </div>
      {call.inCall && (
        <div className="border-t border-kumo-line p-3">
          <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-kumo-tint">
            <div
              className="h-full bg-kumo-brand transition-all duration-75"
              style={{ width: `${Math.min(call.level * 500, 100)}%` }}
            />
          </div>
          <Text size="xs" variant="secondary">
            {call.heard || call.interim
              ? [call.heard, call.interim].filter(Boolean).join(" ")
              : "Listening…"}
          </Text>
        </div>
      )}
      {call.error && (
        <div className="border-t border-kumo-line px-3 py-2">
          <Text size="xs" variant="secondary">
            {call.error}
          </Text>
        </div>
      )}
      <form
        onSubmit={send}
        className="flex gap-2 border-t border-kumo-line p-3"
      >
        <Input
          value={draft}
          aria-label="Message"
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={isStreaming ? "Thinking…" : "Say something…"}
          className="flex-1"
        />
        <Button
          type="button"
          variant={call.inCall ? "destructive" : "secondary"}
          shape="square"
          aria-label={call.inCall ? "End call" : "Start call"}
          onClick={call.inCall ? call.stop : call.start}
          icon={
            call.inCall ? <StopIcon size={16} /> : <MicrophoneIcon size={16} />
          }
        />
        <Button
          type="submit"
          variant="primary"
          disabled={isStreaming || draft.trim() === ""}
          icon={<PaperPlaneRightIcon size={16} />}
        >
          Send
        </Button>
      </form>
    </div>
  );
}

/**
 * The host's console: their own private thread, the QR code that spawns
 * tables, and the tables that have joined. Listing and search read only the
 * hub, so no table's Durable Object wakes for the sidebar.
 */
function HostView({ eventId }: { eventId: string }) {
  const { hub, api } = useHub(eventId);
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const [hostChatId, setHostChatId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const refreshChats = useCallback(async () => {
    const needle = query.trim();
    setChats(
      needle === "" ? await api.listChats() : await api.searchChats(needle)
    );
  }, [api, query]);

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
    [activeId, api, refreshChats]
  );

  // The host's own thread is in the catalog like any other chat; it just
  // does not belong in the list of tables.
  const tables = chats.filter((chat) => chat.metadata?.kind !== "host");

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Text bold>Host console</Text>
          <Badge variant="secondary">event {eventId}</Badge>
          <Badge variant="secondary">{tables.length} tables</Badge>
          {model && <Badge variant="secondary">{model}</Badge>}
        </div>
        <ModeToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 flex-col border-r border-kumo-line">
          <div className="flex items-center gap-2 p-3">
            <Input
              value={query}
              aria-label="Search all tables"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search all tables…"
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
            {tables.length === 0 ? (
              <div className="p-4">
                <Text size="sm" variant="secondary">
                  {query
                    ? "No tables match — the search ran over the hub's index only."
                    : "No tables yet. Each scan of the code creates one, in its own Durable Object."}
                </Text>
              </div>
            ) : (
              tables.map((chat) => (
                <div
                  key={chat.id}
                  className={`group flex w-full items-center justify-between pr-2 hover:bg-kumo-elevated ${
                    activeId === chat.id ? "bg-kumo-elevated" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(chat.id)}
                    className="min-w-0 flex-1 px-4 py-3 text-left"
                  >
                    <div className="truncate">
                      <Text size="sm" bold>
                        {chat.metadata?.title ?? "New table"}
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
                    aria-label="Delete table"
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
          <aside className="w-64 border-l border-kumo-line">
            <JoinCode eventId={eventId} />
          </aside>
        )}
      </div>
    </div>
  );
}

/** One table's device: its own chat, and nothing else. */
function GroupView({ eventId, chatId }: { eventId: string; chatId: string }) {
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <Text bold>{name ?? `Table ${chatId.slice(0, 8)}`}</Text>
        <ModeToggle />
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <ChatPane eventId={eventId} chatId={chatId} onName={setName} />
      </main>
    </div>
  );
}

/**
 * What the QR code points at. Spawns this table's chat and hands the device
 * straight to it, so the participant never sees a join screen.
 */
function JoinView({ eventId }: { eventId: string }) {
  const { hub, api } = useHub(eventId);
  // One chat per scan: without this, a re-render before navigation lands
  // would leave an orphan table in the host's sidebar.
  const claimed = useRef(false);

  useEffect(() => {
    if (!hub.identified || claimed.current) return;
    claimed.current = true;
    void (async () => {
      navigate({ name: "group", eventId, chatId: await api.joinEvent() });
    })();
  }, [api, eventId, hub.identified]);

  return (
    <div className="flex h-screen items-center justify-center">
      <Empty
        icon={<ChatCircleIcon size={24} />}
        title="Joining…"
        description="Setting up a Durable Object for this table."
      />
    </div>
  );
}

function App() {
  const route = useRoute();

  // No route: start a fresh event and send the host to its console.
  useEffect(() => {
    if (route) return;
    navigate({ name: "host", eventId: crypto.randomUUID().slice(0, 8) });
  }, [route]);

  if (!route) return null;
  switch (route.name) {
    case "host":
      return <HostView eventId={route.eventId} />;
    case "join":
      return <JoinView eventId={route.eventId} />;
    case "group":
      return <GroupView eventId={route.eventId} chatId={route.chatId} />;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
