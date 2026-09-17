/**
 * The whole router. Three routes, no dependency: the join link a QR code
 * points at, the host's console hidden behind `/secret`, and one
 * conversation's chat.
 */

export type Route =
  | { name: "host"; eventId: string }
  | { name: "join"; eventId: string }
  | { name: "group"; eventId: string; chatId: string };

export function parseRoute(pathname: string): Route | null {
  const [, head, eventId, kind, chatId] = pathname.split("/");
  if (head !== "events" || !eventId) return null;
  if (!kind) return { name: "join", eventId };
  if (kind === "secret" && !chatId) return { name: "host", eventId };
  if (kind === "group" && chatId) return { name: "group", eventId, chatId };
  return null;
}

export function hrefFor(route: Route): string {
  const event = `/events/${encodeURIComponent(route.eventId)}`;
  switch (route.name) {
    case "join":
      return event;
    case "host":
      return `${event}/secret`;
    case "group":
      return `${event}/group/${encodeURIComponent(route.chatId)}`;
  }
}

export function navigate(route: Route): void {
  history.pushState(null, "", hrefFor(route));
  dispatchEvent(new PopStateEvent("popstate"));
}
