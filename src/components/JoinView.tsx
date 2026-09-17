import { useEffect, useRef } from "react";
import { Empty } from "@cloudflare/kumo";
import { ChatCircleIcon } from "@phosphor-icons/react";
import { navigate } from "../router";
import { useHub } from "../hooks/useHub";

/**
 * What the QR code points at. Spawns this conversation's chat and hands the
 * device straight to it, so the participant never sees a join screen.
 */
export function JoinView({ eventId }: { eventId: string }) {
  const { hub, api } = useHub(eventId);
  // One chat per scan: without this, a re-render before navigation lands
  // would leave an orphan conversation in the host's sidebar.
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
        description="Setting up a Durable Object for this conversation."
      />
    </div>
  );
}
