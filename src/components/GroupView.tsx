import { useState } from "react";
import { PhoneIcon } from "lucide-react";
import { Button } from "@/components/ui/shadcn/button";
import type { ChatUser } from "@/components/ui/chatcn/types";
import type { ConversationState } from "../types";
import { ChatPane } from "./ChatPane";
import { ModeToggle } from "./ModeToggle";

/**
 * This device is one participant in the conversation, whoever is holding it — each
 * scan of the join code is a device, not a person.
 */
const PARTICIPANT: ChatUser = { id: "device", name: "You" };

/** One conversation's device: its own chat, and nothing else. */
export function GroupView({ eventId, chatId }: { eventId: string; chatId: string }) {
  const [conversation, setConversation] = useState<ConversationState | null>(null);

  // Each scan of the join code is one device, so a conversation is always one
  // device however many people share it.
  const people = conversation?.participants;
  const subtitle = people
    ? `${people} ${people === 1 ? "participant" : "participants"} (1 device)`
    : "1 device";

  return (
    <div className="h-screen">
      <ChatPane
        eventId={eventId}
        chatId={chatId}
        currentUser={PARTICIPANT}
        title={conversation?.name ?? `Conversation ${chatId.slice(0, 8)}`}
        subtitle={subtitle}
        onState={setConversation}
        // Taking the slot over means restating the call button, which is why the
        // call state arrives here rather than staying inside `Conversation`.
        actions={({ inCall, startCall }) => (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={inCall ? "Return to call" : "Start call"}
              onClick={startCall}
            >
              <PhoneIcon className="size-4" />
            </Button>
            <ModeToggle />
          </div>
        )}
      />
    </div>
  );
}
