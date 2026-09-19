import {
  ChatMessageActions,
  ChatMessageReply,
  formatTimestamp,
  getBubbleRadius,
} from '@/components/ui/chatcn'
import type { ChatMessageData } from '@/components/ui/chatcn/types'
import { cn } from '@/lib/utils'

/**
 * An activity is a *message*, not a card: something that happened in the project — a
 * report finishing, a session opening, a transcript landing — taking its turn in the
 * conversation alongside what people said. So it renders as a message row: the same
 * incoming/outgoing alignment, the same avatar slot, the same grouping-aware bubble radii,
 * the same inline timestamp, the same hover toolbar. It drops into a column beside
 * ordinary messages and needs the same `ChatProvider` ancestor they do.
 *
 * The content inside the bubble is chatcn's link-preview card with the image dropped:
 * the `chat-content-card` shell around a semibold 13px title, a 12px secondary
 * description, and an optional 11px accent line.
 *
 * **Why this reimplements the message row instead of wrapping `ChatMessage`.** The first
 * version passed the activity through as a `linkPreview` with no `image`, which is
 * genuinely the imageless card for free — chatcn renders the image conditionally. But
 * that card is hard-wired as an `<a href={url}>`, and it prints `url` as its third line.
 * An activity opens something *inside the conversation*, so it has no URL to navigate to
 * or display, and `ChatMessage` offers no slot for custom bubble content. Owning the row
 * is what lets the card be a `<button>` instead, and frees that third line for `meta`.
 * What `meta` is *not* for is a timestamp — the message row renders one just below the
 * card, so a date there reads as a duplicate.
 *
 * The duplication is deliberately partial. Only the branches an activity actually uses
 * are here — avatar, sender label, quoted reply, text, the card, timestamp, hover
 * actions. The image/code/file/voice branches, the lightbox, reactions and read receipts
 * are not, since an activity carries none of them. Everything that can be imported is:
 * `ChatMessageActions`, `ChatMessageReply` and `formatTimestamp` come straight from the
 * barrel, and `getBubbleRadius` does too — chatcn keeps it module-private upstream, so
 * `chat.tsx` and the barrel carry a one-line `export` added on our side. Widening
 * visibility is a cheap, behaviour-free diff to re-apply after a re-pull; a copied lookup
 * table would instead drift out of sync with the bubbles it has to match.
 */

export interface ActivityContent {
  /** First line, semibold — the activity itself, e.g. "Report generated". */
  title: string
  /** Second line — what the activity produced or changed. */
  description?: string
  /**
   * Third line, in the theme accent — where chatcn's link preview is forced to print its
   * URL. Free for whatever situates the activity: an affordance label ("Click to open"),
   * the project or session it belongs to, a status, a count. Not a timestamp, though —
   * the message row already renders one a few pixels below, so a date here reads as a
   * duplicate. If the string names a click, keep it in step with `onOpen`.
   */
  meta?: string
  /**
   * The body a surface opening this activity renders — the transcript behind a call, the
   * prose of a report. Never drawn on the card itself, which stays a three-line summary; this
   * is what is *behind* the click, and only whatever handles `onOpen` reads it.
   */
  detail?: string
}

/** A message whose content is an activity, in place of chatcn's `linkPreview`. */
export interface ActivityMessageData extends Omit<ChatMessageData, 'linkPreview'> {
  activity: ActivityContent
}

export interface ActivityProps {
  message: ActivityMessageData
  isOutgoing?: boolean
  position?: 'solo' | 'first' | 'middle' | 'last'
  showSender?: boolean
  showAvatar?: boolean
  /**
   * Opens whatever the activity refers to, in the conversation itself. Given, the card
   * becomes a `<button>` with a hover affordance; omitted, it is an inert `<div>`, so a
   * static activity does not advertise a click that goes nowhere.
   */
  onOpen?: () => void
  className?: string
}

export function Activity({
  message,
  isOutgoing = false,
  position = 'solo',
  showSender = false,
  showAvatar = false,
  onOpen,
  className,
}: ActivityProps) {
  const { activity } = message
  const timestamp = new Date(message.timestamp)

  const card = (
    <>
      <p className="text-[13px] font-semibold text-[var(--chat-text-primary)]">
        {activity.title}
      </p>
      {activity.description && (
        <p className="mt-0.5 text-[12px] text-[var(--chat-text-secondary)]">
          {activity.description}
        </p>
      )}
      {activity.meta && (
        <p className="mt-1 text-[11px] text-[var(--chat-accent)]">{activity.meta}</p>
      )}
    </>
  )

  return (
    <div
      className={cn(
        'chat-message group/message relative flex items-end gap-2',
        isOutgoing ? 'flex-row-reverse' : 'flex-row',
        position === 'first' || position === 'solo' ? 'mt-4' : 'mt-0.5',
        className
      )}
    >
      {/* Avatar slot — 32px, only for incoming */}
      {!isOutgoing ? (
        <div className="w-8 shrink-0">
          {showAvatar && message.senderAvatar ? (
            <img
              src={message.senderAvatar}
              alt={message.senderName}
              className="size-8 rounded-full object-cover"
            />
          ) : showAvatar ? (
            <div className="flex size-8 items-center justify-center rounded-full bg-[var(--chat-bubble-incoming)] text-[11px] font-semibold text-[var(--chat-text-secondary)]">
              {message.senderName.charAt(0).toUpperCase()}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex max-w-[75%] flex-col">
        {showSender && !isOutgoing && (
          <span className="mb-0.5 ml-3 text-[14px] leading-tight font-semibold tracking-[-0.01em] text-[var(--chat-text-secondary)]">
            {message.senderName}
          </span>
        )}

        <div className="relative">
          <ChatMessageActions message={message} isOutgoing={isOutgoing} />

          <div
            className={cn(
              'chat-bubble relative px-3.5 py-2',
              isOutgoing
                ? 'bg-[var(--chat-bubble-outgoing)] text-[var(--chat-bubble-outgoing-text)]'
                : 'bg-[var(--chat-bubble-incoming)] text-[var(--chat-bubble-incoming-text)]',
              getBubbleRadius(isOutgoing, position)
            )}
          >
            {message.replyTo && (
              <ChatMessageReply replyTo={message.replyTo} isOutgoing={isOutgoing} />
            )}

            {message.text && (
              <p className="text-[15px] leading-[1.35] tracking-[-0.01em] break-words whitespace-pre-wrap">
                {message.text}
              </p>
            )}

            {onOpen ? (
              <button
                type="button"
                onClick={onOpen}
                className="chat-content-card mt-1.5 block w-full px-3 py-2 text-left transition-opacity hover:opacity-90"
              >
                {card}
              </button>
            ) : (
              <div className="chat-content-card mt-1.5 px-3 py-2">{card}</div>
            )}

            <div
              className={cn(
                'mt-1 flex items-center gap-1',
                isOutgoing ? 'justify-end' : 'justify-start'
              )}
            >
              {message.isEdited && (
                <span className="text-[10px] italic opacity-50">edited</span>
              )}
              <time className="text-[11px] tracking-[0.02em] opacity-60">
                {formatTimestamp(timestamp)}
              </time>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
