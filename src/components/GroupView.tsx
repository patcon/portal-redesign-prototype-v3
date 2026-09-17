import { useState } from "react";
import { Text } from "@cloudflare/kumo";
import type { ConversationState } from "../types";
import { ChatPane } from "./ChatPane";
import { ModeToggle } from "./ModeToggle";

/** One conversation's device: its own chat, and nothing else. */
export function GroupView({ eventId, chatId }: { eventId: string; chatId: string }) {
  const [conversation, setConversation] = useState<ConversationState | null>(
    null
  );
  // Each scan of the join code is one device, so a conversation is always one
  // device however many people share it.
  const people = conversation?.participants;
  const subtitle = people
    ? `${people} ${people === 1 ? "participant" : "participants"} (1 device)`
    : "1 device";
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex flex-col">
          <Text bold>
            {conversation?.name ?? `Conversation ${chatId.slice(0, 8)}`}
          </Text>
          <Text size="xs" variant="secondary">
            {subtitle}
          </Text>
        </div>
        <ModeToggle />
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <ChatPane eventId={eventId} chatId={chatId} onState={setConversation} />
      </main>
    </div>
  );
}
