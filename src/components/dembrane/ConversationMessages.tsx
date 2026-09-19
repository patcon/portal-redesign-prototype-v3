import { ChevronDown } from 'lucide-react'
import * as React from 'react'
import {
  ChatDateSeparator,
  ChatSystemMessage,
  ChatMessage,
  ChatTypingIndicator,
  groupMessages,
  useAutoScroll,
  useChatContext,
} from '@/components/ui/chatcn'
import type { ChatMessageData, TypingUser } from '@/components/ui/chatcn/types'
import { Activity } from './Activity'
import type { ActivityMessageData } from './Activity'
import { PlatformMessage, platformBubbleStyle } from './PlatformMessage'
import type { PlatformMessageData } from './PlatformMessage'
import { cn } from '@/lib/utils'

/**
 * chatcn's `ChatMessages`, but able to render an `Activity` in the flow.
 *
 * This is the "list component that dispatches on message kind" that `Activity`'s own
 * story names as the missing piece. chatcn's `ChatMessages` takes a
 * `ChatMessageData[]` and renders every entry itself through `ChatMessageGroup` →
 * `ChatMessage`, with no seam to hand it a different component for one message. Adding
 * a render prop upstream would mean changing vendored behaviour, not just widening
 * visibility, so the dispatch lives here instead.
 *
 * Almost nothing is reimplemented. The grouping (`groupMessages`), the scroll behaviour
 * (`useAutoScroll`), the context, and the date-separator, system-message and
 * typing-indicator components are all chatcn's, imported from the barrel — `groupMessages`
 * even groups activities correctly, because an `ActivityMessageData` *is* a
 * `ChatMessageData` as far as sender and timestamp go. What is rewritten is only the
 * ~30-line group renderer, so that each message in a run can go to `Activity` or
 * `ChatMessage` depending on whether it carries an `activity`, and the scroll-to-bottom
 * button, which lives in the same JSX.
 *
 * The consequence of that split is worth stating: position, avatar and sender-label rules
 * inside a group are duplicated from `ChatMessageGroup`. They are three lines of index
 * arithmetic, and getting them wrong shows up immediately as mismatched bubble corners.
 */

/** A message in a dembrane conversation — an ordinary chat message, an activity, or one from dembrane itself. */
export type ConversationMessage = ChatMessageData | ActivityMessageData | PlatformMessageData

function isActivity(message: ConversationMessage): message is ActivityMessageData {
  return 'activity' in message
}

function isPlatform(message: ConversationMessage): message is PlatformMessageData {
  return 'isPlatform' in message && message.isPlatform === true
}

export interface ConversationMessagesProps {
  messages: ConversationMessage[]
  typingUsers?: TypingUser[]
  /** Called when an activity card is clicked. Without it, activity cards are inert. */
  onActivityOpen?: (message: ActivityMessageData) => void
  /**
   * chatcn's hover action toolbar — reply, react, and a more menu with edit/pin/delete.
   * Defaults to `false` here: on this surface the actions are unwired and mostly
   * distracting, and a toolbar that appears on every hover competes with the activity
   * cards for attention.
   *
   * Suppression is by CSS, not by prop — see the `[data-chat-actions]` rule in
   * `index.css`, which also carries a TODO about doing this properly in the registry
   * component. `ChatMessageActions` renders unconditionally and takes no flag.
   */
  showMessageActions?: boolean
  className?: string
}

export function ConversationMessages({
  messages,
  typingUsers = [],
  onActivityOpen,
  showMessageActions = false,
  className,
}: ConversationMessagesProps) {
  const { currentUser, messageGroupingInterval } = useChatContext()
  const { containerRef, scrollToBottom, isAtBottom, unseenCount } = useAutoScroll(messages)

  const items = React.useMemo(
    () => groupMessages(messages, currentUser.id, messageGroupingInterval),
    [messages, currentUser.id, messageGroupingInterval]
  )

  return (
    <div
      data-chat-actions={showMessageActions ? undefined : 'off'}
      className={cn('chat-messages relative flex flex-1 flex-col overflow-hidden', className)}
    >
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto w-full max-w-3xl">
          {items.map((item, i) => {
            switch (item.type) {
              case 'date':
                return <ChatDateSeparator key={`date-${item.label}-${i}`} label={item.label} />
              case 'system':
                return <ChatSystemMessage key={item.message.id} message={item.message} />
              case 'group': {
                const { group } = item
                const len = group.messages.length

                return (
                  <div
                    key={`group-${group.messages[0].id}`}
                    className={cn(
                      'chat-message-group',
                      group.isOutgoing ? 'items-end' : 'items-start'
                    )}
                  >
                    {group.messages.map((msg, index) => {
                      // Same rules as chatcn's ChatMessageGroup: the run's ends get the
                      // rounded corners, the sender label goes on the first, the avatar
                      // on the last.
                      const position =
                        len === 1
                          ? 'solo'
                          : index === 0
                            ? 'first'
                            : index === len - 1
                              ? 'last'
                              : 'middle'
                      const shared = {
                        isOutgoing: group.isOutgoing,
                        position,
                        showSender: index === 0,
                        showAvatar: position === 'solo' || position === 'last',
                      } as const

                      if (isActivity(msg)) {
                        const activity = (
                          <Activity
                            message={msg}
                            onOpen={onActivityOpen && (() => onActivityOpen(msg))}
                            {...shared}
                          />
                        )
                        // An activity dembrane authored still gets dembrane's tint on its
                        // bubble, the same as an ordinary platform message — `isActivity`
                        // is checked first only to decide *which* component renders it.
                        return isPlatform(msg) ? (
                          <div key={msg.id} style={platformBubbleStyle}>
                            {activity}
                          </div>
                        ) : (
                          <React.Fragment key={msg.id}>{activity}</React.Fragment>
                        )
                      }

                      if (isPlatform(msg)) {
                        return (
                          <PlatformMessage
                            key={msg.id}
                            message={msg}
                            showAvatar={shared.showAvatar}
                            showSender={shared.showSender}
                          />
                        )
                      }

                      return <ChatMessage key={msg.id} message={msg} {...shared} />
                    })}
                  </div>
                )
              }
            }
          })}

          {typingUsers.length > 0 && <ChatTypingIndicator users={typingUsers} />}
        </div>
      </div>

      <button
        onClick={() => scrollToBottom('smooth')}
        className={cn(
          'absolute right-4 bottom-4 z-5 flex size-10 items-center justify-center rounded-full border border-[var(--chat-border-strong)] bg-[var(--chat-bg-main)] shadow-[var(--chat-shadow-md)] transition-all duration-200',
          isAtBottom
            ? 'pointer-events-none translate-y-2 opacity-0'
            : 'translate-y-0 opacity-100'
        )}
        aria-label={
          unseenCount > 0
            ? `${unseenCount} new messages, scroll to bottom`
            : 'Scroll to bottom'
        }
      >
        <ChevronDown className="size-[18px] text-[var(--chat-text-secondary)]" />
        {unseenCount > 0 && (
          <span className="absolute -top-1 -right-1 flex size-[18px] items-center justify-center rounded-full bg-[var(--chat-accent)] text-[11px] font-bold text-white tabular-nums">
            {unseenCount > 9 ? '9+' : unseenCount}
          </span>
        )}
      </button>
    </div>
  )
}
