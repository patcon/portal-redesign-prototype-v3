import * as React from 'react'
import { Phone, Search } from 'lucide-react'
import { ChatComposer, ChatProvider } from '@/components/ui/chatcn'
import type { ChatTheme, ChatUser, TypingUser } from '@/components/ui/chatcn/types'
import type { ActivityMessageData } from './Activity'
import { ConversationMessages } from './ConversationMessages'
import type { ConversationMessage } from './ConversationMessages'
import { cn } from '@/lib/utils'

/**
 * A single conversation: header, message list, composer — plus a shelf between the first
 * two for whatever is happening *around* the thread rather than in it (see `banners`).
 *
 * Inspired by chatcn's `FullMessenger`, which is the same thing with a 320px
 * conversation-list sidebar to its left. Almost none of that layout survives the cut,
 * so this duplicates the small amount it does rather than trying to parameterize
 * `FullMessenger` into serving both shapes. The header in particular is inlined rather
 * than imported from chatcn: it is the part most likely to grow dembrane-specific
 * affordances, and `src/components/ui/chatcn/` is vendored code that a registry re-pull
 * overwrites.
 *
 * What it does share with the chatcn layouts is the contract: it mounts its own
 * `ChatProvider`, so it is self-contained and needs no chat context from its parent —
 * and, in Storybook, opts out of the global provider decorator with
 * `parameters: { chat: false }`.
 *
 * Sizing: the flex column lives on `ChatProvider`'s *own* div via its `className`, not on
 * a div nested inside it. `ChatProvider` renders a bare `<div data-chat-theme>` with no
 * height of its own, so an inner `h-full` would resolve against an auto-height parent,
 * collapse to content height, and leave the composer floating under the last message
 * instead of pinned to the bottom. (This is why `.storybook/preview.tsx` passes the
 * provider a `flex h-dvh flex-col` className.) `ConversationMessages` is `flex-1`, so it takes
 * the slack between header and composer.
 *
 * The component is `h-full` overall: it fills whatever bounded ancestor it is given, and
 * collapses to content height without one.
 */

interface ConversationProps {
  currentUser: ChatUser
  theme?: ChatTheme
  /** Header title — the conversation name. */
  title: string
  subtitle?: string
  /**
   * Drawn to the left of the title. Defaults to an initial-letter disc built from
   * `title`; pass `null` for no avatar at all.
   */
  avatar?: React.ReactNode
  /** Presence dot on the default avatar. Ignored when `avatar` is overridden. */
  presence?: 'online' | 'away' | 'offline'
  /**
   * Header buttons. Defaults to a call/search pair — `FullMessenger` also shows a pin,
   * dropped here as unlikely to be wanted and so just noise. Both default buttons are inert
   * unless wired: the phone takes `onCall`, and search has nothing behind it yet. Pass
   * `null` for no buttons at all, or a node to replace the pair outright.
   */
  actions?: React.ReactNode
  /**
   * Starts a call from the default header phone button, which is `disabled` and dimmed
   * without it rather than advertising a click that goes nowhere. Withhold it while a call
   * is already up — the banner in `banners` is the way back to that call, and a second
   * phone button beside it offers to start one that cannot exist. Ignored when `actions` is
   * overridden — a caller supplying its own buttons wires its own handlers.
   */
  onCall?: () => void
  /**
   * Rows pinned between the header and the message list: an ongoing call
   * (`LiveCallBanner`), a pinned-message strip, a connection or recording notice. Plural
   * deliberately — pass a fragment and they stack top to bottom in the order given, so a
   * second concern can arrive later without reworking the slot. They are flex siblings of
   * the header, so they hold position while the list scrolls beneath them.
   */
  banners?: React.ReactNode
  /** Ordinary chat messages, activities, or a mix — see `ConversationMessages`. */
  messages: ConversationMessage[]
  typingUsers?: TypingUser[]
  /**
   * Called when an activity card in the thread is clicked, so the surrounding surface can
   * open whatever it refers to. Without it, activity cards render inert.
   */
  onActivityOpen?: (message: ActivityMessageData) => void
  /**
   * chatcn's hover action toolbar on each message. Off by default — see
   * `ConversationMessages`, which explains why and how it is suppressed.
   */
  showMessageActions?: boolean
  onSend: (text: string) => void
  placeholder?: string
  className?: string
}

function Conversation({
  currentUser,
  theme = 'lunar',
  title,
  subtitle,
  avatar,
  presence,
  actions,
  onCall,
  banners,
  messages,
  typingUsers,
  onActivityOpen,
  showMessageActions,
  onSend,
  placeholder,
  className,
}: ConversationProps) {
  return (
    <ChatProvider
      currentUser={currentUser}
      theme={theme}
      className={cn('flex h-full flex-col bg-[var(--chat-bg-main)]', className)}
    >
      <>
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--chat-border)] bg-[var(--chat-bg-header)] px-4 py-3 backdrop-blur-[20px] backdrop-saturate-[180%]">
          {avatar === undefined ? (
            <div className="relative shrink-0">
              <div className="flex size-10 items-center justify-center rounded-full bg-[var(--chat-bubble-incoming)] text-sm font-semibold text-[var(--chat-text-primary)]">
                {title.charAt(0).toUpperCase()}
              </div>
              {presence === 'online' && (
                <div className="absolute -right-0.5 -bottom-0.5 size-[10px] rounded-full border-2 border-[var(--chat-bg-main)] bg-[var(--chat-green)]" />
              )}
            </div>
          ) : (
            avatar
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-[var(--chat-text-primary)]">
              {title}
            </span>
            {subtitle && (
              <span className="truncate text-[12px] text-[var(--chat-text-secondary)]">
                {subtitle}
              </span>
            )}
          </div>
          {actions === undefined ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onCall}
                disabled={!onCall}
                aria-label="Start call"
                className="flex size-8 items-center justify-center rounded-lg text-[var(--chat-text-secondary)] hover:bg-[var(--chat-accent-soft)] disabled:pointer-events-none disabled:opacity-40"
              >
                <Phone className="size-4" />
              </button>
              <button className="flex size-8 items-center justify-center rounded-lg text-[var(--chat-text-secondary)] hover:bg-[var(--chat-accent-soft)]">
                <Search className="size-4" />
              </button>
            </div>
          ) : (
            actions
          )}
        </header>

        {banners && <div className="flex shrink-0 flex-col">{banners}</div>}

        <ConversationMessages
          messages={messages}
          typingUsers={typingUsers}
          onActivityOpen={onActivityOpen}
          showMessageActions={showMessageActions}
        />
        <ChatComposer onSend={onSend} placeholder={placeholder} />
      </>
    </ChatProvider>
  )
}

export { Conversation }
export type { ConversationProps }
