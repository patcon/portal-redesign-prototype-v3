import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button, Empty, Input, Surface, Text } from "@cloudflare/kumo";
import {
  ChatCircleIcon,
  MicrophoneIcon,
  PaperPlaneRightIcon,
  StopIcon,
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { MAX_TEXT } from "../shared";
import type { ConversationState } from "../types";
import { useCall } from "../hooks/useCall";

/**
 * One conversation's messages, composer and call controls. Used by both the
 * host console and a conversation's own device; the two differ only in which
 * callbacks they pass.
 */
export function ChatPane({
  eventId,
  chatId,
  onActivity,
  onState,
}: {
  eventId: string;
  chatId: string;
  onActivity?: () => void;
  onState?: (state: ConversationState) => void;
}) {
  // One WebSocket per open chat. The upgrade goes through the event hub,
  // which resolves the chat ID; the chat's own DO then owns the socket,
  // so the hub is not on the message path.
  const basePath = `agents/project-hub/${encodeURIComponent(eventId)}/chats/${encodeURIComponent(chatId)}`;
  const agent = useAgent<ConversationState>({
    agent: "group-chat",
    // Ignored for the URL, which `basePath` sets, but `useAgentChat` keys its
    // message cache by agent and name. Without it every routed chat is
    // "default", and switching chats keeps showing the first one opened.
    name: chatId,
    basePath,
    onStateUpdate: (state) => onState?.(state),
  });
  const call = useCall(basePath);
  const { messages, sendMessage, status } = useAgentChat({
    agent,
    experimental_throttle: 100,
  });
  const [draft, setDraft] = useState("");
  const isStreaming = status === "streaming" || status === "submitted";
  const tail = useRef<HTMLDivElement>(null);

  // The host's sidebar reads pushed metadata, which only lands once a turn
  // finishes — so refresh on the streaming edge, not on every token. Held in
  // a ref: a fresh callback each render would otherwise re-fire this effect,
  // refresh the list, re-render, and loop for as long as a chat is open.
  const activity = useRef(onActivity);
  // Assigned from an effect rather than during render; effects run in
  // declaration order, so it is current before the one below reads it.
  useEffect(() => {
    activity.current = onActivity;
  });
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
    [draft, isStreaming, sendMessage],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <Empty
            icon={<ChatCircleIcon size={24} />}
            title="Connecting…"
            description="This conversation's Durable Object is waking up."
          />
        ) : (
          messages.map((message) => {
            const text = message.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
            if (!text) return null;
            const isCall =
              (message.metadata as { kind?: string } | undefined)?.kind === "voice-call";
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
                      <Text size="sm">{text.replace(/^Voice call transcript:\n/, "")}</Text>
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
      <form onSubmit={send} className="flex gap-2 border-t border-kumo-line p-3">
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
          icon={call.inCall ? <StopIcon size={16} /> : <MicrophoneIcon size={16} />}
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
