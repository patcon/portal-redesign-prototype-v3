/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConversationListItem } from "./ConversationsShell";

afterEach(cleanup);

describe("ConversationListItem", () => {
  const row = { id: "c1", title: "Harbour table", lastMessage: "Ferries, mostly" };

  it("falls back to the conversation's initial as its avatar", () => {
    render(<ConversationListItem row={row} isActive={false} onSelect={vi.fn<() => void>()} />);

    expect(screen.getByText("H")).toBeTruthy();
  });

  it("takes an icon in place of the initial, for a thread that is not a conversation", () => {
    render(
      <ConversationListItem
        row={{ id: "host", title: "Host thread", lastMessage: "Ask about the room" }}
        icon={<svg data-testid="host-icon" />}
        isActive={false}
        onSelect={vi.fn<() => void>()}
      />,
    );

    expect(screen.getByTestId("host-icon")).toBeTruthy();
    expect(screen.queryByText("H")).toBeNull();
    // Still a row of the list: same title, same preview line, same open affordance.
    expect(screen.getByRole("button", { name: "Open Host thread" })).toBeTruthy();
    expect(screen.getByText("Ask about the room")).toBeTruthy();
  });
});
