import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ChatUser } from "@/components/ui/chatcn/types";
import { CallScreen, Conversation, LiveCallBanner } from "@/components/dembrane";
import type { ActivityMessageData } from "@/components/dembrane/Activity";
import { Button } from "@/components/ui/shadcn/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/shadcn/drawer";
import { MAX_TEXT, pauseMarker } from "../shared";
import { withPauseMarkers, type LivePause } from "./liveTranscript";
import type { ConversationState } from "../types";
import { useCall } from "../hooks/useCall";
import { useRecordingHref, useRecordings } from "../hooks/useRecordings";
import { createTimestampBook, recordingIdsOf, toConversationMessages } from "./adapt";

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
  callable = true,
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
   * button has to be restated by whoever takes the slot over. It is also told
   * whether this conversation takes calls at all, so a slot that draws a phone
   * button can disable it rather than each caller tracking that separately.
   */
  actions?: (call: { callable: boolean; inCall: boolean; startCall: () => void }) => ReactNode;
  /**
   * Whether this conversation can hold a call. False for the host's own thread:
   * it is a private chat with the model about the room, not a conversation
   * anyone speaks into, and a transcript left behind there would be the host
   * talking to themselves. Off, the call button stays on screen but disabled —
   * a thread that visibly takes no calls, rather than one whose phone has
   * quietly gone missing — and no voice socket is opened for the thread at all.
   */
  callable?: boolean;
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
  const call = useCall(callable ? basePath : null);
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

  // A call's voice note is written before it has any audio, so how long it is
  // and how loud it has been come from the recording itself — re-read while the
  // call is still running, so the bars grow as people speak.
  const recordingIds = useMemo(() => recordingIdsOf(messages), [messages]);
  const recordings = useRecordings(eventId, chatId, recordingIds);
  const recordingHref = useRecordingHref(eventId, chatId);
  // `call.inCall` is true only on the device holding the voice socket, so the
  // host — reading the same thread, wanting to listen in — is never locked out.
  const thread = useMemo(
    () =>
      toConversationMessages(messages, currentUser, timestampOf, {
        recordingHref,
        recordings,
        recordingHere: call.inCall,
      }),
    [messages, currentUser, timestampOf, recordingHref, recordings, call.inCall],
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

  // Pauses in the call so far, each pinned to how much had been heard when the
  // microphone went quiet. The thread's copy of this transcript is marked up on
  // the server, from the gap in the audio; this one never goes through there, so
  // the same marks are made here, off the mute button that caused the gap.
  const [pauses, setPauses] = useState<LivePause[]>([]);
  const mutedAt = useRef<{ since: number; at: number } | null>(null);
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    if (call.muted) {
      mutedAt.current = { since: Date.now(), at: call.heard.length };
      return;
    }
    const paused = mutedAt.current;
    mutedAt.current = null;
    if (!paused) return;
    setPauses((marks) => [
      ...marks,
      { at: paused.at, marker: pauseMarker(Date.now() - paused.since) },
    ]);
    // On `call.muted` alone, deliberately: `call.heard` is read at the moment
    // the microphone goes quiet, and re-running this on every word would keep
    // moving the mark to the end of what has been said since.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [call.muted]);

  // A new call is a new transcript: nothing from the last one belongs in it.
  useEffect(() => {
    if (!call.inCall) {
      mutedAt.current = null;
      setPauses([]);
    }
  }, [call.inCall]);
  /* oxlint-enable react/set-state-in-effect */

  // The call as it is being spoken: what has been transcribed, plus the phrase still
  // in flight. `CallScreen` takes one block of prose — the transcription is not
  // diarized, so there are no turns to break it into.
  const transcript = [withPauseMarkers(call.heard, pauses), call.interim]
    .filter(Boolean)
    .join(" ");

  // The activity whose panel is open, or `null`. A call's card carries a trimmed line
  // of its transcript; the whole thing is behind the click, in the drawer below.
  const [openedActivity, setOpenedActivity] = useState<ActivityMessageData | null>(null);

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
        actions={actions?.({ callable, inCall: call.inCall, startCall: openCall })}
        onCall={callable && !call.inCall ? call.start : undefined}
        messages={thread}
        onActivityOpen={setOpenedActivity}
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

      {/*
        Half the viewport, the shape the design repo settles on: the panel is a place
        rather than a message, so it opens to the same size every time and leaves the
        top of the conversation readable behind it.
      */}
      <Drawer
        open={openedActivity !== null}
        onOpenChange={(next) => !next && setOpenedActivity(null)}
      >
        {/*
          No `DrawerDescription`: the card's description is a trimmed opening of the
          very transcript below it, so printing it here is the same words twice, the
          second time directly above the full version. `aria-describedby={undefined}`
          is what Radix needs to stop looking for the description that is gone.
        */}
        <DrawerContent className="h-[50dvh]!" aria-describedby={undefined}>
          <DrawerHeader>
            <DrawerTitle>{openedActivity?.activity.title ?? "Activity"}</DrawerTitle>
          </DrawerHeader>
          {/*
            The transcript as it was spoken: one undiarized blob, shown the way
            `CallScreen` shows it while the call is live. An empty `detail` is a call
            that ended before any audio came back, which is worth saying rather than
            leaving as a blank panel.
          */}
          <div className="text-muted-foreground flex-1 space-y-3 overflow-y-auto px-4 pb-4">
            {openedActivity?.activity.detail ? (
              <p className="whitespace-pre-wrap">{openedActivity.activity.detail}</p>
            ) : (
              <p>No transcript — the call ended before any audio came back.</p>
            )}
          </div>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline">Close</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

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
