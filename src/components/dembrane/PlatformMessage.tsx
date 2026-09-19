import * as React from 'react'
import { ChatMessage } from '@/components/ui/chatcn'
import type { ChatMessageData } from '@/components/ui/chatcn/types'

/**
 * Fixed brand blue, not a `--chat-*` token: this represents dembrane's own identity as
 * the message sender, so it deliberately stays constant across lunar/aurora/ember/midnight
 * rather than theming with the rest of the surface.
 */
const PLATFORM_BUBBLE_BG = '#DBEAFE'
const PLATFORM_BUBBLE_TEXT = '#1E3A8A'

/**
 * The CSS custom-property overrides that give an incoming bubble dembrane's own tint.
 * `PlatformMessage` applies these to `ChatMessage`'s bubble; `ConversationMessages` applies
 * the same object around an `Activity` card when the activity is one dembrane authored, so
 * an activity in the thread reads as dembrane's regardless of which component renders it.
 */
export const platformBubbleStyle: React.CSSProperties = {
  '--chat-bubble-incoming': PLATFORM_BUBBLE_BG,
  '--chat-bubble-incoming-text': PLATFORM_BUBBLE_TEXT,
} as React.CSSProperties

/** A message from dembrane itself, distinguished from a human participant's by this flag. */
export interface PlatformMessageData extends ChatMessageData {
  isPlatform: true
}

interface PlatformMessageProps {
  message: ChatMessageData
  showAvatar?: boolean
  showSender?: boolean
  className?: string
}

/**
 * `ChatMessage` wrapped with a fixed light-blue bubble color, for messages from the
 * platform itself rather than a human participant. Overrides the two incoming bubble CSS
 * variables `ChatMessage` reads from, on a wrapper div inside `ChatProvider`'s tree,
 * rather than forking its markup. Always incoming — dembrane is never the "self" side of
 * a thread, so there is no `isOutgoing` prop.
 */
function PlatformMessage({ message, showAvatar = true, showSender = true, className }: PlatformMessageProps) {
  return (
    <div style={platformBubbleStyle}>
      <ChatMessage
        message={message}
        isOutgoing={false}
        position="solo"
        showAvatar={showAvatar}
        showSender={showSender}
        className={className}
      />
    </div>
  )
}

export { PlatformMessage }
export type { PlatformMessageProps }

