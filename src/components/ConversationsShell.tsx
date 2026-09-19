import type { ReactNode } from "react";
import { ChevronLeftIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { ChatProvider } from "@/components/ui/chatcn";
import type { ChatUser } from "@/components/ui/chatcn/types";
import { Button } from "@/components/ui/shadcn/button";
import { cn } from "@/lib/utils";
import type { ConversationRow } from "./adapt";

/**
 * A conversation list beside a conversation, or — narrower than `md` — a list that
 * drills into one and back.
 *
 * This is chatcn's `FullMessenger` shape, rebuilt rather than reused. `FullMessenger`
 * is a fixed 320px sidebar with no drill-in, it renders the thread itself out of raw
 * `ChatMessages` and `ChatComposer`, and it lives in `ui/chatcn/`, which the next copy
 * from `dembrane-portal-redesign` overwrites. So the sidebar is composed *around*
 * `Conversation` here, and the vendored file is left alone.
 *
 * One piece of state decides the whole layout: whether a conversation is selected. At
 * `md` and up both panes are always mounted; below it, exactly one of them shows.
 *
 * Sizing: `ChatProvider` renders a bare `div` with no height of its own, so the flex
 * row has to live on *its* className — a nested `h-full` would resolve against an
 * auto-height parent, collapse, and unpin the composer at the bottom of the thread.
 */
export function ConversationsShell({
  currentUser,
  title,
  rows,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  query,
  onQueryChange,
  emptyListMessage,
  headerActions,
  pinnedRow,
  children,
}: {
  currentUser: ChatUser;
  /** Names the list, not any conversation — the sidebar's own heading. */
  title: string;
  rows: ConversationRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate?: () => void;
  onDelete?: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  emptyListMessage: string;
  /** Icons beside the sidebar heading — sharing, theme. */
  headerActions?: ReactNode;
  /** A row above the list proper, for a thread that is not one of the conversations. */
  pinnedRow?: ReactNode;
  /** The selected conversation. Rendered only when something is selected. */
  children?: ReactNode;
}) {
  const selected = activeId !== null;

  return (
    <ChatProvider currentUser={currentUser} className="flex h-dvh bg-[var(--chat-bg-app)]">
      <aside
        className={cn(
          "flex w-full shrink-0 flex-col border-r border-[var(--chat-border-strong)] bg-[var(--chat-bg-sidebar)] md:w-80",
          // Below `md` the two panes take turns; at `md` and up the sidebar is
          // always there and the main panel fills what is left.
          selected && "hidden md:flex",
        )}
      >
        <div className="flex items-center gap-1 px-4 py-3">
          <span className="flex-1 truncate text-[15px] font-semibold text-[var(--chat-text-primary)]">
            {title}
          </span>
          {headerActions}
          {onCreate && (
            <Button variant="ghost" size="icon" aria-label="New conversation" onClick={onCreate}>
              <PlusIcon className="size-4" />
            </Button>
          )}
        </div>

        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-[10px] bg-[var(--chat-bg-main)] px-3">
            <SearchIcon className="size-3.5 shrink-0 text-[var(--chat-text-tertiary)]" />
            <input
              value={query}
              aria-label="Search all conversations"
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder="Search all conversations…"
              className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-[var(--chat-text-primary)] placeholder:text-[var(--chat-text-tertiary)] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {pinnedRow}
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--chat-text-secondary)]">
              {emptyListMessage}
            </p>
          ) : (
            rows.map((row) => (
              <ConversationListItem
                key={row.id}
                row={row}
                isActive={row.id === activeId}
                onSelect={() => onSelect(row.id)}
                onDelete={onDelete && (() => onDelete(row.id))}
              />
            ))
          )}
        </div>
      </aside>

      <main
        className={cn(
          "min-w-0 flex-1 flex-col bg-[var(--chat-bg-main)]",
          selected ? "flex" : "hidden md:flex",
        )}
      >
        {children}
      </main>
    </ChatProvider>
  );
}

/**
 * One row in the list. Adapted from `ConversationItem` in chatcn's `layouts.tsx`,
 * which is module-private — thirty lines of markup copied is a smaller liability than
 * a second export added to a vendored barrel.
 *
 * The delete button is a sibling of the row button, not nested inside it: a button
 * within a button is invalid, and the two do different things.
 *
 * Exported because the host's pinned thread is one of these too: it belongs to the
 * list it sits above, and the way to make it read that way is to be the same row,
 * with an icon where a conversation shows its initial.
 */
export function ConversationListItem({
  row,
  icon,
  isActive,
  onSelect,
  onDelete,
}: {
  row: ConversationRow;
  /**
   * Fills the avatar disc in place of the title's first letter. For a thread that
   * is not one of the conversations — the host's own — where an initial would read
   * as the name of somebody at the event.
   */
  icon?: ReactNode;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-xl pr-1 transition-colors",
        isActive ? "bg-[var(--chat-accent-soft)]" : "hover:bg-[var(--chat-accent-soft)]",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open ${row.title}`}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--chat-bubble-incoming)] text-[13px] font-semibold text-[var(--chat-text-secondary)]">
          {icon ?? row.title.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-[var(--chat-text-primary)]">
            {row.title}
          </div>
          <div className="truncate text-[13px] text-[var(--chat-text-secondary)]">
            {row.lastMessage}
          </div>
        </div>
      </button>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${row.title}`}
          className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={onDelete}
        >
          <Trash2Icon className="size-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * The back chevron that returns a narrow screen to the list. Goes in `Conversation`'s
 * `avatar` slot, which sits exactly where a back affordance belongs — to the left of
 * the title — so no new prop has to be threaded through the copied component.
 */
export function BackToList({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Back to conversations"
      onClick={onBack}
      className="md:hidden"
    >
      <ChevronLeftIcon className="size-5" />
    </Button>
  );
}
