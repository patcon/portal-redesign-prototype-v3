/**
 * A scroll container that stays glued to its bottom as content grows, and stops following the
 * moment the reader scrolls away — plus a count of what has landed since they did, for the
 * affordance that offers them the way back.
 *
 * chatcn's `useAutoScroll` (`src/components/ui/chatcn/hooks.ts`) does the same job, but it
 * diffs `messages.length` to work out how much the reader missed, and the call transcript is
 * one string that gets longer rather than a list of items. So this diffs the value's identity
 * instead: one change is one arrival, which for a transcript fed a chunk at a time is exactly
 * the count you want. Ours rather than a patch to the vendored copy, since a chatcn re-pull
 * would overwrite the change.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** How close to the bottom still counts as being at it, in px. */
const THRESHOLD = 100

function useStickyScroll<T>(value: T, opts?: { threshold?: number }) {
  /**
   * The element in state, and a callback ref to put it there, rather than a plain `useRef`.
   * The panel this is written for lives inside a portalled drawer, which is not in the DOM on
   * the first commit — so a ref-reading effect finds `null`, and with nothing in its deps that
   * changes when the element arrives, it never runs again. That is a listener attached to
   * nothing, and an `isAtBottom` stuck at its initial `true` forever. State re-renders.
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const containerRef = useCallback((el: HTMLDivElement | null) => setContainer(el), [])

  const [isAtBottom, setIsAtBottom] = useState(true)
  const [unseenCount, setUnseenCount] = useState(0)
  const threshold = opts?.threshold ?? THRESHOLD

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      if (!container) return

      container.scrollTo({ top: container.scrollHeight, behavior })
      setUnseenCount(0)
    },
    [container]
  )

  useEffect(() => {
    if (!container) return

    const onScroll = () => {
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <= threshold

      setIsAtBottom(atBottom)
      if (atBottom) setUnseenCount(0)
    }

    container.addEventListener('scroll', onScroll, { passive: true })

    return () => container.removeEventListener('scroll', onScroll)
  }, [container, threshold])

  const previous = useRef(value)

  useEffect(() => {
    if (value === previous.current) return

    previous.current = value

    // `'instant'`, not `'smooth'`, and that is load-bearing rather than taste: a smooth scroll
    // fires the handler above all the way down, so a chunk landing mid-animation would be read
    // as arriving while the reader is away and counted as unseen. Following instantly leaves no
    // window for that, and a transcript glued to its bottom is what a terminal does anyway.
    if (isAtBottom) scrollToBottom('instant')
    else setUnseenCount((n) => n + 1)
  }, [value, isAtBottom, scrollToBottom])

  // Content can already be present when the container turns up — a call reopened from the
  // banner, say. `scrollToBottom` changes identity with the container, so this runs then.
  useEffect(() => {
    scrollToBottom('instant')
  }, [scrollToBottom])

  return { containerRef, scrollToBottom, isAtBottom, unseenCount }
}

export { useStickyScroll }
