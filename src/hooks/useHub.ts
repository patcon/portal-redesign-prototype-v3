import { useRef } from "react";
import { useAgent } from "agents/react";
import { CHATS_CHANGED } from "../shared";
import type { HubApi } from "../types";

/**
 * A connection to the event hub, plus its typed remote surface.
 *
 * `onChatsChanged` is held in a ref so a caller may pass a fresh closure on
 * every render without re-running the connection.
 */
export function useHub(eventId: string, onChatsChanged?: () => void) {
  const changed = useRef(onChatsChanged);
  changed.current = onChatsChanged;
  const hub = useAgent({
    agent: "project-hub",
    name: eventId,
    // The hub nudges its sockets when a conversation's entry changes — one
    // naming itself, a new message, a call — so the sidebar stays live.
    onMessage: (message) => {
      if (typeof message.data !== "string") return;
      try {
        if (JSON.parse(message.data).type === CHATS_CHANGED) changed.current?.();
      } catch {
        // Not ours: the SDK's own frames are handled before this.
      }
    },
  });
  return { hub, api: hub.stub as HubApi };
}
