import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ChatUser } from "@/components/ui/chatcn/types";
import { CallScreen, Conversation, LiveCallBanner } from "@/components/dembrane";
import { MAX_TEXT } from "../shared";
import type { ConversationState } from "../types";
import { useCall } from "../hooks/useCall";
import { createTimestampBook, toConversationMessages } from "./adapt";

/**
 * One conversation's messages, composer and call. Used by both the host console and
 * a conversation's own device; the two differ only in which callbacks they pass.
 *
 * Everything visible here comes from the copied design system — `Conversation` draws
 * the header, the thread and the composer, `CallScreen` and `LiveCallBanner` draw the
 * call. What this component owns is the wiring: the sockets above, and the small
 * amount of call state the agents SDK does not keep for it.
 */
export function ChatPane({
  eventId,
  chatId,
  currentUser,
  title,
  subtitle,
  avatar,
  actions,
  onActivity,
  onState,
}: {
  eventId: string;
  chatId: string;
  currentUser: ChatUser;
  title: string;
  subtitle?: string;
  /** Passed through to `Conversation`; the shell uses it for a back button. */
  avatar?: ReactNode | null;
  /**
   * Header icons. Supplying this replaces `Conversation`'s default phone-and-search
   * pair outright, so it is handed the call state and the way to start one — the
   * button has to be restated by whoever takes the slot over.
   */
  actions?: (call: { inCall: boolean; startCall: () => void }) => ReactNode;
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
  const isStreaming = status === "streaming" || status === "submitted";

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

  // Survives re-renders but not a change of conversation, which is what `key`
  // on the caller's side already gives us: a different chat is a different pane.
  // Held as lazily-initialised state rather than a ref, so it is never read
  // during render before an effect has filled it in.
  const [timestampOf] = useState(createTimestampBook);
  const thread = useMemo(
    () => toConversationMessages(messages, currentUser, timestampOf),
    [messages, currentUser, timestampOf],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim().slice(0, MAX_TEXT);
      if (!trimmed || isStreaming) return;
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    },
    [isStreaming, sendMessage],
  );

  // What the SDK's voice client does not track for us: `startedAt`, the clock both call
  // surfaces count from, and which screen the call is showing on. Mute is *not* here —
  // it belongs to the voice client, which is what gates the microphone.
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [onCallScreen, setOnCallScreen] = useState(false);
  // Synchronising with an external system — the voice socket — which is the one
  // thing effects are for. `call.inCall` is pushed from the transport, so there is
  // no render-time value to derive these from and no event handler that sees the
  // call end: it can end because the server hung up.
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    if (call.inCall) {
      setStartedAt((at) => at ?? new Date());
      setOnCallScreen(true);
    } else {
      setStartedAt(null);
      setOnCallScreen(false);
    }
  }, [call.inCall]);
  /* oxlint-enable react/set-state-in-effect */

  // The call as it is being spoken: what has been transcribed, plus the phrase still
  // in flight. `CallScreen` takes one block of prose — the transcription is not
  // diarized, so there are no turns to break it into.
  const transcript = [call.heard, call.interim].filter(Boolean).join(" ");

  // Starts a call, or returns to the one already running. Both the header button and
  // the banner want this single "show me the call" action.
  const openCall = useCallback(() => {
    if (call.inCall) setOnCallScreen(true);
    else call.start();
  }, [call]);

  return (
    <>
      <Conversation
        currentUser={currentUser}
        title={title}
        subtitle={subtitle}
        avatar={avatar}
        actions={actions?.({ inCall: call.inCall, startCall: openCall })}
        onCall={call.inCall ? undefined : call.start}
        messages={thread}
        onSend={send}
        placeholder={isStreaming ? "Thinking…" : "Say something…"}
        banners={
          <>
            {call.inCall && !onCallScreen && (
              <LiveCallBanner
                startedAt={startedAt ?? undefined}
                muted={call.muted}
                onReturn={openCall}
              />
            )}
            {call.error && (
              <p className="bg-destructive/10 text-destructive px-4 py-2 text-xs">{call.error}</p>
            )}
          </>
        }
      />

      {onCallScreen && (
        // Fixed rather than a sibling in the flex column: the call is a screen that
        // covers the conversation, and `CallScreen` is `h-full` with no position of
        // its own, so the overlay is this component's job.
        <div className="fixed inset-0 z-50">
          <CallScreen
            title={title}
            startedAt={startedAt ?? undefined}
            transcript={transcript}
            muted={call.muted}
            onMutedChange={call.toggleMute}
            onMinimize={() => setOnCallScreen(false)}
            onHangUp={call.stop}
          />
        </div>
      )}
    </>
  );
}
