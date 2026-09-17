import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { absoluteHrefFor } from "../router";

/**
 * Rendered from `location.origin`, so the code encodes whatever address the
 * host actually opened the console on. Serve on the LAN address and the QR
 * points at the LAN address; there is no configured hostname to get wrong.
 */
export function JoinCode({ eventId }: { eventId: string }) {
  const joinUrl = absoluteHrefFor({ name: "join", eventId }, location.origin);
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(joinUrl);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [joinUrl]);

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-muted-foreground text-sm">Scan to join this event</p>
      {/* White regardless of theme: a dark QR code does not scan. */}
      <div
        className="w-48 rounded-lg bg-white p-2"
        // Generated from our own join URL, not from anything a user typed.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="text-muted-foreground text-xs break-all select-all">{joinUrl}</p>
    </div>
  );
}
