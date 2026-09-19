import { MicOff, Phone, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeDuration, formatDuration, isoDuration, useCallSeconds } from './callDuration'

/**
 * A full-width bar that says a call is happening and takes you back to it — WhatsApp's
 * "Tap to return to call" strip, which sits directly under the chat header for as long as
 * the call runs.
 *
 * **Why this is chrome and not a message.** An ongoing call is ambient state: it is not a
 * turn in the conversation, nothing about it belongs in the transcript, and it must stay
 * visible however far the thread is scrolled. So unlike `Activity` — which goes to some
 * length to render *as* a message row, sharing the bubble radii and the hover toolbar —
 * this is a sibling of the header, living in `Conversation`'s `banners` slot. The two
 * components answer opposite questions: `Activity` is something that happened, this is
 * something that is still happening.
 *
 * **Where the green comes from.** `--chat-green`, the same token the header's presence dot
 * uses, so the bar re-themes across lunar / aurora / ember / midnight with everything
 * else. The WhatsApp reference supplies the *shape* — full-width bar, icon disc, short
 * label, ticking duration, the whole surface tappable — and not the colour; the brand
 * hexes (`#25D366`, `#00A884`) are deliberately not here, since a hard-coded green would
 * be the one thing on the surface that ignores the active theme. The hover and active
 * states darken the token in place with `color-mix` for the same reason.
 *
 * **Where the yellow comes from, and why it breaks that rule.** Muted, the bar is a raw
 * Tailwind `yellow-400` rather than a `--chat-*` token. There is no `--chat-yellow` to
 * reach for, but that is the smaller half of it: this yellow's whole job is to match the
 * three marks on `CallScreen` that together mean *the call is held* — the pressed mute
 * toggle, the stopped timer, the stage's dot — and that screen has a fixed dark palette of
 * its own rather than a re-themable one. A yellow that shifted with the theme would agree
 * with the conversation behind it and disagree with the call it is about, which is the
 * wrong way round. So the green is a token for exactly the reason the yellow is not.
 *
 * **Sizing.** No height and no position of its own; it is one row in a flex column that
 * the conversation pins above its scrolling message list. It also does not assume it is
 * the *only* row — no bottom margin and no rounding, so a pinned-message strip or a
 * connection notice can stack directly beneath it.
 */

interface LiveCallBannerProps {
  /**
   * When the call started. The duration counts up from here, live, and re-derives from the
   * clock on every tick rather than incrementing — a throttled background tab resyncs
   * instead of drifting behind. Omit it for a bar with no duration at all: a call that is
   * still connecting has no elapsed time to show.
   */
  startedAt?: Date
  /**
   * The call is muted: the bar goes yellow and the duration holds where it is, so this
   * counts how long the call has been *listening* rather than how long it has been open.
   * The same `useCallSeconds(startedAt, muted)` call `CallScreen`'s own header makes, which
   * is what keeps the two surfaces agreeing to the second.
   */
  muted?: boolean
  /** Defaults to `'Tap to return to call'`, or its muted counterpart. */
  label?: string
  /** Picks the icon — a handset or a camera. Muted, it is a crossed-out mic either way. */
  variant?: 'voice' | 'video'
  /**
   * Returns to the call. Omitted, the bar is `disabled` rather than advertising a click
   * that goes nowhere — the same reasoning as `Activity`'s `onOpen`.
   */
  onReturn?: () => void
  className?: string
}

function LiveCallBanner({
  startedAt,
  muted = false,
  label,
  variant = 'voice',
  onReturn,
  className,
}: LiveCallBannerProps) {
  const seconds = useCallSeconds(startedAt, muted)

  // Resolved here rather than as a parameter default, so an explicit `label` still wins in
  // both states and the muted wording is not something a caller has to know to pass.
  const text = label ?? (muted ? 'Muted · tap to return to call' : 'Tap to return to call')
  const Icon = muted ? MicOff : variant === 'video' ? Video : Phone
  const duration = startedAt ? formatDuration(seconds) : null

  return (
    <button
      type="button"
      onClick={onReturn}
      disabled={!onReturn}
      aria-label={
        startedAt
          ? // A stopped clock does not look stopped in the second you glance at it, so the
            // label says so outright — the same wording `CallScreen`'s held timer carries.
            `${text}, ${describeDuration(seconds)}${muted ? ', paused' : ''}`
          : text
      }
      className={cn(
        'flex w-full shrink-0 items-center gap-3 px-4 py-2.5 text-left transition-colors duration-[var(--chat-duration-fast)] ease-[var(--chat-ease)]',
        muted
          ? 'bg-yellow-400 text-neutral-900'
          : 'bg-[var(--chat-green)] text-white',
        onReturn &&
          (muted
            ? 'hover:bg-yellow-300 active:bg-yellow-500'
            : 'hover:bg-[color-mix(in_oklab,var(--chat-green)_88%,black)] active:bg-[color-mix(in_oklab,var(--chat-green)_78%,black)]'),
        className
      )}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full',
          muted ? 'bg-black/10' : 'bg-white/20'
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="flex-1 truncate text-[13px] font-medium tracking-[-0.01em]">
        {text}
      </span>
      {duration && (
        <time
          dateTime={isoDuration(seconds)}
          className="shrink-0 text-[13px] tabular-nums"
        >
          {duration}
        </time>
      )}
    </button>
  )
}

export { LiveCallBanner }
export type { LiveCallBannerProps }
