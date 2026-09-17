/**
 * The call timer, shared by `LiveCallBanner` and `CallScreen` — both surfaces count the same
 * call, so they have to agree to the second. Its own module rather than an export off either
 * component, so neither owns it and the component files stay component-only.
 */
import { useEffect, useRef, useState } from 'react'

const elapsedSeconds = (startedAt: Date) =>
  Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))

/**
 * `m:ss` under an hour, `h:mm:ss` from an hour on — what WhatsApp's own call timer does.
 * `date-fns` is a dependency but its duration helpers produce prose ("about 2 minutes"),
 * and chatcn's formatters in `hooks.ts` are all wall-clock, so neither fits.
 */
function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Spoken form for the `aria-label`, since "2:41" reads as a time of day. */
function describeDuration(seconds: number) {
  const parts: string[] = []
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60

  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s > 0 || parts.length === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`)

  return parts.join(' ')
}

/** ISO 8601 duration, for the `<time dateTime>` the visible counter sits in. */
function isoDuration(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)

  return `PT${h > 0 ? `${h}H` : ''}${m > 0 ? `${m}M` : ''}${seconds % 60}S`
}

/**
 * The ticking half of the timer, shared with `CallScreen` — both surfaces show the same
 * counter for the same call, so they must agree to the second. Re-derives from the clock on
 * every tick rather than incrementing, so a throttled background tab resyncs instead of
 * drifting behind, and seeds from the clock rather than 0 so the first paint is already right.
 *
 * `paused` holds it: muting stops the count, and unmuting carries on from where it stopped
 * rather than catching up to the wall clock. That makes this a count of how long the call has
 * been *listening*, not how long it has been open — which is the number that means anything to
 * someone deciding whether the table has been recorded for long enough.
 *
 * Which is why elapsed time can no longer come from `startedAt` alone: the counter banks each
 * running stretch as it ends, and clock-derives only the stretch currently running. The drift
 * resistance survives that, since the running stretch is still measured rather than counted.
 */
function useCallSeconds(startedAt?: Date, paused = false) {
  const [seconds, setSeconds] = useState(() => (startedAt ? elapsedSeconds(startedAt) : 0))
  const startedAtMs = startedAt?.getTime()

  /** Milliseconds from running stretches that have already ended. */
  const banked = useRef(0)
  /** When the stretch currently running began — `null` while paused. */
  const since = useRef<number | null>(null)
  /** Whether the counter has run at all, so the first stretch can start at the call itself. */
  const started = useRef(false)

  useEffect(() => {
    if (startedAtMs === undefined) return

    if (paused) {
      // Bank whatever was running: the stretch since the last unmute, or — for a call that
      // arrives here already muted — everything since the call itself began. The guard is what
      // makes that safe to run twice: a stretch that has already been banked leaves `since`
      // null behind it, so a repeated effect has nothing left to bank and must not bank the
      // whole call again. (`started` distinguishes that from a first run, which legitimately
      // has no `since` yet.)
      if (since.current !== null || !started.current) {
        banked.current += Date.now() - (since.current ?? startedAtMs)
        since.current = null
        started.current = true
        setSeconds(Math.max(0, Math.floor(banked.current / 1000)))
      }

      return
    }

    // The first stretch runs from when the call started rather than from when this mounted, so
    // a call already underway shows the right figure on its first paint; every later one runs
    // from the moment of unmuting, which is what keeps the muted time out of the count.
    //
    // Reusing a `since` that is already set is what keeps that true under StrictMode, whose
    // mount / unmount / remount would otherwise flip `started` between the two runs and restart
    // an already-underway call from 0:00. It is also what makes a *changed* `startedAt` a no-op
    // for a counter that is already running — which is how two surfaces showing one call stay
    // agreed when the owner restamps the origin for whichever of them mounts next.
    const from = since.current ?? (started.current ? Date.now() : startedAtMs)

    since.current = from
    started.current = true

    const elapsed = () => banked.current + (Date.now() - from)
    const tick = () => setSeconds(Math.max(0, Math.floor(elapsed() / 1000)))

    tick()

    // The interval is phased to the *call's* second boundary rather than to this mount, so two
    // counters over one call flip at the same moment. Ticking from the mount instead leaves
    // them up to a second apart for as long as both are up — which is what you see on
    // returning to a call from its banner, the one moment the two are compared.
    let interval: ReturnType<typeof setInterval> | undefined
    const align = setTimeout(() => {
      tick()
      interval = setInterval(tick, 1000)
    }, 1000 - (elapsed() % 1000))

    return () => {
      clearTimeout(align)
      if (interval !== undefined) clearInterval(interval)
    }
  }, [startedAtMs, paused])

  return seconds
}

export { useCallSeconds, formatDuration, describeDuration, isoDuration }
