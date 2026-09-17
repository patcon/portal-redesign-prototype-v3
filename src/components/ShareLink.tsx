import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/shadcn/button";
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
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">Direct link to this conversation</p>
      <p className="text-muted-foreground text-xs break-all select-all">{url}</p>
      <Button variant="secondary" onClick={copy}>
        {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
        {copied ? "Copied" : "Copy link"}
      </Button>
      {clipboardFailed && (
        <p className="text-muted-foreground text-xs">
          Couldn't reach the clipboard — select the link above to copy it.
        </p>
      )}
    </div>
  );
}
