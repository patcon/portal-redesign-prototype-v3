/**
 * The whole router. Three routes, no dependency: the host's console, the
 * join link a QR code points at, and one conversation's chat.
 */

export type Route =
  | { name: "host"; eventId: string }
  | { name: "join"; eventId: string }
  | { name: "group"; eventId: string; chatId: string };

export function parseRoute(pathname: string): Route | null {
  const [, head, a, b] = pathname.split("/");
  if (head === "host" && a) return { name: "host", eventId: a };
  if (head === "join" && a) return { name: "join", eventId: a };
  if (head === "g" && a && b) return { name: "group", eventId: a, chatId: b };
  return null;
}

export function hrefFor(route: Route): string {
  const event = encodeURIComponent(route.eventId);
  switch (route.name) {
    case "host":
      return `/host/${event}`;
    case "join":
      return `/join/${event}`;
    case "group":
      return `/g/${event}/${encodeURIComponent(route.chatId)}`;
  }
}

export function navigate(route: Route): void {
  history.pushState(null, "", hrefFor(route));
  dispatchEvent(new PopStateEvent("popstate"));
}
