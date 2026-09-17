/**
 * Runtime guards for the hub's remote surface: every method that uses these
 * is reachable from a browser, so the argument is untrusted until checked.
 */

export function assertText(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(
      `${what} must be a non-empty string of at most ${max} characters`
    );
  }
  return value;
}

export function assertChatId(value: unknown): string {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new Error("chatId must be an entry id");
  }
  return value;
}
