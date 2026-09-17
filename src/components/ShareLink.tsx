import { useCallback, useEffect, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { absoluteHrefFor } from "../router";

/**
 * The direct link to one conversation, for handing to the device running it.
 * The event's QR code always makes a *new* conversation, so without this there
 * is no way back to one that already exists.
 */
export function ShareLink({ eventId, chatId }: { eventId: string; chatId: string }) {
  const url = absoluteHrefFor({ name: "group", eventId, chatId }, location.origin);
  const [copied, setCopied] = useState(false);
  // Clipboard access needs a secure context, which a LAN address over plain
  // HTTP is not. The link is on screen either way, so a refusal costs the host
  // a manual copy rather than the link.
  const [clipboardFailed, setClipboardFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setClipboardFailed(false);
      })
      .catch(() => setClipboardFailed(true));
  }, [url]);

  return (
    <div className="flex flex-col gap-2 border-t border-kumo-line p-4">
      <Text size="sm" variant="secondary">
        Direct link to this conversation
      </Text>
      <div className="break-all select-all">
        <Text size="xs" variant="secondary">
          {url}
        </Text>
      </div>
      <Button
        variant="secondary"
        onClick={copy}
        icon={copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
      {clipboardFailed && (
        <Text size="xs" variant="secondary">
          Couldn't reach the clipboard — select the link above to copy it.
        </Text>
      )}
    </div>
  );
}
