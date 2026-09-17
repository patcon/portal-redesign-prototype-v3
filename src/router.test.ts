import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute, type Route } from "./router";

describe("parseRoute", () => {
  it("reads the join link", () => {
    expect(parseRoute("/events/abc123")).toEqual({
      name: "join",
      eventId: "abc123"
    });
    expect(parseRoute("/events/abc123/")).toEqual({
      name: "join",
      eventId: "abc123"
    });
  });

  it("reads the host console", () => {
    expect(parseRoute("/events/abc123/secret")).toEqual({
      name: "host",
      eventId: "abc123"
    });
  });

  it("reads one conversation's chat", () => {
    expect(parseRoute("/events/abc123/group/chat-9")).toEqual({
      name: "group",
      eventId: "abc123",
      chatId: "chat-9"
    });
  });

  it("rejects anything else", () => {
    expect(parseRoute("/")).toBeNull();
    expect(parseRoute("/events")).toBeNull();
    expect(parseRoute("/events/")).toBeNull();
    expect(parseRoute("/host/abc123")).toBeNull();
    expect(parseRoute("/events/abc123/secret/extra")).toBeNull();
    expect(parseRoute("/events/abc123/group")).toBeNull();
    expect(parseRoute("/events/abc123/elsewhere")).toBeNull();
  });
});

describe("hrefFor", () => {
  const cases: [Route, string][] = [
    [{ name: "join", eventId: "abc123" }, "/events/abc123"],
    [{ name: "host", eventId: "abc123" }, "/events/abc123/secret"],
    [
      { name: "group", eventId: "abc123", chatId: "chat-9" },
      "/events/abc123/group/chat-9"
    ]
  ];

  it.each(cases)("writes %o as %s", (route, href) => {
    expect(hrefFor(route)).toBe(href);
  });

  it("round-trips through parseRoute", () => {
    for (const [route] of cases) expect(parseRoute(hrefFor(route))).toEqual(route);
  });

  it("escapes ids that would otherwise change the path", () => {
    expect(hrefFor({ name: "host", eventId: "a/b" })).toBe("/events/a%2Fb/secret");
  });
});
