import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Mic,
  MicOff,
  Minimize2,
  PhoneOff,
  Volume2,
  VolumeOff,
} from 'lucide-react'
import dembraneLogomark from '@/assets/dembrane-logomark.svg'
import { Badge } from '@/components/ui/shadcn/badge'
import { Button } from '@/components/ui/shadcn/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/shadcn/drawer'
import { Toggle } from '@/components/ui/shadcn/toggle'
import { cn } from '@/lib/utils'
import { describeDuration, formatDuration, isoDuration, useCallSeconds } from './callDuration'
import { useStickyScroll } from './stickyScroll'

/**
 * The screen a live Echo call fills — the surface `LiveCallBanner` takes you back to. It is
 * modelled on WhatsApp's mobile call screen: a dark full-bleed stage with the conversation
 * title at the top, a large avatar in the middle saying who you are connected to, and the
 * call controls docked in a drawer at the bottom.
 *
 * **Why a drawer and not a fixed bar.** The controls row is the drawer's *collapsed* state,
 * not a separate component that a panel happens to sit above. Dragging the handle up reveals
 * the live transcript in the same sheet, so one gesture moves between "I am on a call" and
 * "I am reading what the call is saying" without leaving the screen. Two snap points only —
 * the controls row, and full — because there is no useful third thing to peek at.
 *
 * **Why it reads the shadcn tokens, not `--chat-*`.** This is not chat surface. It renders no
 * bubbles, mounts no `ChatProvider`, and its palette is a fixed dark one rather than a
 * re-themable conversation ground. The `dark` class on the root is load-bearing: it is what
 * makes the shadcn components inside — the drawer, the toggles, the hang-up button — resolve
 * their `bg-popover` / `bg-muted` tokens dark, instead of each needing a colour override.
 *
 * **The controls are toggles, except the one that isn't.** Speaker and mute are states you
 * hold, so they are `Toggle`s with `aria-pressed` doing the work and no visible label — the
 * icon swaps to the crossed-out variant when pressed, and an `aria-label` carries the name.
 * Hanging up is not a state, so it is a `Button`.
 */

interface CallScreenProps {
  /** Names the call — the table or conversation, not a person. */
  title: string
  /**
   * The disc on the stage. Omitted, it is the Dembrane logomark on a green disc — the caller
   * is Dembrane itself, not anyone at the table; pass `null` for a stage with no disc at all.
   * The same `undefined` / `null` sentinel `Conversation` uses for its header avatar.
   */
  avatar?: ReactNode | null
  /** Defaults to `'Connected to Dembrane'`. */
  connectedLabel?: string
  /** When the call started. Omitted, the header shows no timer. */
  startedAt?: Date
  /**
   * What the call has said so far, as one block of prose. Transcription is not diarized, so
   * there are no speakers to attribute and nothing to break into turns; the pipeline closes
   * a chunk every 30 seconds or whenever the user mutes, and the chunks arrive here already
   * joined by `'... '`. Only visible once the drawer is dragged up.
   */
  transcript?: string
  /** Initial mute state; pass `onMutedChange` to drive it from outside. */
  muted?: boolean
  onMutedChange?: (muted: boolean) => void
  /**
   * Initial speakerphone state, on by default — a table talking into a shared device wants
   * the room to hear the reply, so anything else is the wrong way round to start.
   */
  speakerOn?: boolean
  onSpeakerOnChange?: (speakerOn: boolean) => void
  /**
   * Opens audio setup — picking input and output device. Reached by long-pressing the audio
   * control or tapping the chevron on its corner. Omitted, neither affordance is rendered
   * and the control is a plain speakerphone toggle.
   */
  onAudioSetup?: () => void
  /** Sends the call back to the banner. Omitted, the button is not rendered. */
  onMinimize?: () => void
  onHangUp?: () => void
  className?: string
}

/**
 * How vaul's `px` snap points work, because both constants below depend on it and it is not
 * what it looks like: the sheet is anchored `bottom-0` and translated *down* by
 * `containerHeight - snapPoint`, so a snap point is the height of the sheet's own **top**
 * edge downward, and only a sheet as tall as the container shows exactly that much. Give the
 * content any less height and the shortfall comes straight off every snap point — which is
 * why `DrawerContent` below is a full `100dvh` and clears the header by way of
 * `EXPANDED_SNAP`, not by being shorter.
 */

/**
 * The collapsed snap point, and the exact sum of everything at the top of the sheet that is
 * meant to show there: the handle's `mt-4` and `h-1`, then the controls row's `pt-4`, its
 * `size-14` controls, and its `pb-6`.
 *
 * Which makes this the wrong dial for how the row is seated. The gap under the buttons is
 * the row's own `pb-6` and nothing else — this number only decides whether you see all of
 * that padding or the fold cuts some off. Padding the row and then trimming the sheet's
 * height to hide the excess is the same mistake twice: change the row, then bring this back
 * into agreement with it.
 */
const CONTROLS_SNAP = '116px'

/**
 * The header's own height: its `pt-4` plus its `size-11` button. The expanded snap point is
 * the viewport less this, so the sheet tops out just under the header — reading the
 * transcript should not cost you the title of the call you are reading, or the way back out
 * of it.
 */
const HEADER_HEIGHT = 88

/**
 * The viewport height, tracked. `100dvh` handles the *sheet*, but vaul needs the same number
 * as a plain integer to compute a snap point from, and there is no CSS route to that.
 */
function useViewportHeight() {
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight
  )

  useEffect(() => {
    const measure = () => setHeight(window.innerHeight)

    measure()
    window.addEventListener('resize', measure)

    return () => window.removeEventListener('resize', measure)
  }, [])

  return height
}

/** How long a press has to be held before it counts as a request for audio setup. */
const LONG_PRESS_MS = 500

/** The circular, icon-only control the drawer's row is built from. */
function CallToggle({
  pressed,
  onPressedChange,
  label,
  className,
  children,
  ...props
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  label: string
  children: ReactNode
} & Omit<ComponentProps<typeof Toggle>, 'pressed' | 'onPressedChange' | 'children'>) {
  return (
    <Toggle
      {...props}
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={label}
      // `className` merges rather than being overridden, so a caller can restate the pressed
      // colour — which mute does, since pressed there means the call is held, not just that a
      // control is on.
      className={cn(
        "size-14 rounded-full px-0 text-neutral-100 hover:bg-white/10 hover:text-white data-[state=on]:bg-white data-[state=on]:text-neutral-900 [&_svg:not([class*='size-'])]:size-6",
        className
      )}
    >
      {children}
    </Toggle>
  )
}

/**
 * The left control: a speakerphone toggle on tap, and a way into audio setup on a long press
 * or a tap of the chevron on its corner. The chevron exists because a long press is
 * invisible — nobody discovers a gesture that leaves no mark on the screen — so the two
 * affordances are one feature with a visible half and a fast half.
 */
function AudioControl({
  speakerOn,
  onSpeakerOnChange,
  onAudioSetup,
}: {
  speakerOn: boolean
  onSpeakerOnChange: (speakerOn: boolean) => void
  onAudioSetup?: () => void
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A long press still ends in a click, which Radix reads as a toggle. This swallows that
  // one click, so opening setup never also flips speakerphone behind the sheet.
  const opened = useRef(false)

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  const start = () => {
    if (!onAudioSetup) return
    opened.current = false
    cancel()
    timer.current = setTimeout(() => {
      opened.current = true
      onAudioSetup()
    }, LONG_PRESS_MS)
  }

  return (
    <span className="relative">
      <CallToggle
        pressed={speakerOn}
        onPressedChange={(next) => {
          if (opened.current) {
            opened.current = false
            return
          }
          onSpeakerOnChange(next)
        }}
        label={speakerOn ? 'Turn off speakerphone' : 'Turn on speakerphone'}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
      >
        {speakerOn ? <Volume2 /> : <VolumeOff />}
      </CallToggle>

      {/*
        The badge tracks the toggle it sits on rather than holding a look of its own: pressed,
        the control is a white disc with a dark icon, so a translucent-white badge on top of it
        reads as a smudge. The border is the seam between the two in either state.
      */}
      {onAudioSetup && (
        <button
          type="button"
          onClick={onAudioSetup}
          aria-label="Audio setup"
          className={cn(
            'absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border border-neutral-900 transition-colors',
            speakerOn
              ? 'bg-white text-neutral-900 hover:bg-neutral-200'
              : 'bg-white/20 text-neutral-100 hover:bg-white/35'
          )}
        >
          <ChevronUp className="size-3" />
        </button>
      )}
    </span>
  )
}

function CallHeader({
  title,
  startedAt,
  onMinimize,
  muted,
}: Pick<CallScreenProps, 'title' | 'startedAt' | 'onMinimize'> & { muted: boolean }) {
  const seconds = useCallSeconds(startedAt, muted)

  return (
    <header className="absolute inset-x-0 top-0 z-10 flex items-start gap-3 px-4 pt-4">
      {onMinimize ? (
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Minimize call"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-neutral-100 transition-colors hover:bg-white/20"
        >
          <Minimize2 className="size-5" />
        </button>
      ) : (
        <span className="size-11 shrink-0" />
      )}

      <div className="flex min-w-0 flex-1 flex-col items-center pt-1.5">
        <h1 className="max-w-full truncate text-[17px] font-semibold tracking-[-0.02em]">
          {title}
        </h1>
        {startedAt && (
          <time
            dateTime={isoDuration(seconds)}
            // Colour is the only visual difference between a running and a held timer — a
            // stopped clock does not look stopped in the second you glance at it — so the
            // label has to say so outright for anyone not reading the colour.
            aria-label={
              muted ? `${describeDuration(seconds)}, paused` : describeDuration(seconds)
            }
            className={cn(
              'text-[13px] tabular-nums',
              muted ? 'text-yellow-400' : 'text-neutral-400'
            )}
          >
            {formatDuration(seconds)}
          </time>
        )}
      </div>

      {/* Balances the minimize button so the title stays optically centred. */}
      <span className="size-11 shrink-0" />
    </header>
  )
}

/** The middle of the screen: who you are connected to, and that you still are. */
function CallStage({
  avatar,
  connectedLabel,
  muted,
}: Pick<CallScreenProps, 'avatar' | 'connectedLabel'> & { muted: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
      {avatar === undefined ? (
        <div className="flex size-40 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600">
          {/* Decorative: the label underneath already names who is on the call. */}
          <img src={dembraneLogomark} alt="" className="size-20" />
        </div>
      ) : (
        avatar
      )}

      {connectedLabel && (
        <p className="flex items-center gap-2 text-[15px] text-neutral-400">
          {/*
            The pulse is the tell that something is still coming in, so muting takes it away
            along with the green — a yellow dot that kept breathing would say the call is held
            and running at the same time.
          */}
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              muted ? 'bg-yellow-400' : 'animate-pulse bg-emerald-500'
            )}
          />
          {connectedLabel}
        </p>
      )}
    </div>
  )
}

/**
 * The always-open bottom drawer. `modal={false}` so the screen behind stays interactive and
 * `dismissible={false}` so a downward drag lands back on the controls row instead of closing
 * a sheet that has no way to reopen — there is no trigger and no close button.
 */
function CallControlsDrawer({
  transcript,
  muted,
  onMutedChange,
  speakerOn,
  onSpeakerOnChange,
  onAudioSetup,
  onHangUp,
}: {
  transcript: string
  muted: boolean
  onMutedChange: (muted: boolean) => void
  speakerOn: boolean
  onSpeakerOnChange: (speakerOn: boolean) => void
  onAudioSetup?: () => void
  onHangUp?: () => void
}) {
  const [snap, setSnap] = useState<number | string | null>(CONTROLS_SNAP)
  const { containerRef, scrollToBottom, isAtBottom, unseenCount } = useStickyScroll(transcript)
  // A fraction would only approximate the header's height, and would drift with the viewport:
  // 0.9 clears 88px at phone height and half that on a short window. So: measure.
  const expandedSnap = `${useViewportHeight() - HEADER_HEIGHT}px`
  /**
   * Memoised for its identity, not for the cost. vaul re-runs the effect that
   * writes the sheet's transform whenever this array changes, which snaps it
   * back to the active point — so a fresh array on every render cancels a drag
   * in progress. The transcript grows while the call is live, so the drawer
   * could only be pulled back down once muting stopped the re-renders.
   */
  const snapPoints = useMemo(() => [CONTROLS_SNAP, expandedSnap], [expandedSnap])

  return (
    <Drawer
      open
      modal={false}
      dismissible={false}
      snapPoints={snapPoints}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
    >
      {/*
        The `!` modifiers beat `DrawerContent`'s own `data-[vaul-drawer-direction=bottom]:`
        defaults, which tailwind-merge can't cancel across a variant prefix: the built-in
        `max-h-[80vh]` and `mt-24` would both shrink the sheet, and per the note on
        `CONTROLS_SNAP` a shorter sheet does not top out lower — it just shows that much less
        at every snap point.
      */}
      <DrawerContent className="mt-0! h-[100dvh]! max-h-none! rounded-t-2xl border-white/10 bg-neutral-900 text-neutral-100 [&>div:first-child]:bg-white/20">
        {/* Required for accessibility, but the reference has no drawer title. */}
        <DrawerTitle className="sr-only">Call controls</DrawerTitle>

        <div className="flex shrink-0 items-center justify-between px-8 pt-4 pb-6">
          <AudioControl
            speakerOn={speakerOn}
            onSpeakerOnChange={onSpeakerOnChange}
            onAudioSetup={onAudioSetup}
          />

          {/*
            Yellow rather than the white every other pressed control uses, matching the held
            timer and the stage's dot: those three are one signal — the call is paused — and a
            white mute button would read as just another toggle that happens to be on.
          */}
          <CallToggle
            pressed={muted}
            onPressedChange={onMutedChange}
            label={muted ? 'Unmute' : 'Mute'}
            className="data-[state=on]:bg-yellow-400 data-[state=on]:hover:bg-yellow-300"
          >
            {muted ? <MicOff /> : <Mic />}
          </CallToggle>

          <Button
            type="button"
            onClick={onHangUp}
            aria-label="Hang up"
            className="size-14 rounded-full bg-red-500 text-white hover:bg-red-600 [&_svg:not([class*='size-'])]:size-6"
          >
            <PhoneOff />
          </Button>
        </div>

        <div className="relative flex-1 overflow-hidden">
          {/*
            `pb-28` is not spacing, it is the tail of the sheet. The sheet is a full `100dvh`
            but tops out at `HEADER_HEIGHT`, so its last 88px sit below the fold — without this,
            the end of the transcript is scrolled to a place the screen does not reach.
          */}
          <div
            ref={containerRef}
            className="h-full overflow-y-auto px-6 pb-28 text-[15px] leading-relaxed"
          >
            {transcript ? (
              <p className="text-neutral-300">{transcript}</p>
            ) : (
              <p className="text-neutral-500">Listening…</p>
            )}
          </div>

          {/*
            The way back down, for a reader who has scrolled up while the call kept talking.
            `bottom-28` is the same 112px as the scroller's `pb-28` and for the same reason —
            anchored any lower, the pill sits in the part of the sheet that is below the fold.
            It is faded rather than unmounted so it has somewhere to animate from, which means
            `pointer-events-none` is what actually takes it out of reach when it is not offered.
          */}
          <Badge
            asChild
            className={cn(
              'absolute bottom-28 left-1/2 h-7 -translate-x-1/2 gap-1.5 px-3 text-[13px] shadow-lg transition-all duration-200',
              isAtBottom && 'pointer-events-none translate-y-2 opacity-0'
            )}
          >
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              aria-label={
                unseenCount > 0
                  ? `${unseenCount} new, jump to latest`
                  : 'Jump to latest'
              }
            >
              <ChevronDown />
              {unseenCount > 0 ? `${unseenCount} new` : 'Jump to latest'}
            </button>
          </Badge>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function CallScreen({
  title,
  avatar,
  connectedLabel = 'Connected to Dembrane',
  startedAt,
  transcript = '',
  muted: mutedProp = false,
  onMutedChange,
  speakerOn: speakerOnProp = true,
  onSpeakerOnChange,
  onAudioSetup,
  onMinimize,
  onHangUp,
  className,
}: CallScreenProps) {
  // Seeded from the props and then owned locally, so the controls respond on their own in a
  // story with no wiring, while a consumer that passes a handler still hears every change.
  const [muted, setMuted] = useState(mutedProp)
  const [speakerOn, setSpeakerOn] = useState(speakerOnProp)

  return (
    <div
      className={cn(
        'dark relative flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-100',
        className
      )}
    >
      <CallHeader title={title} startedAt={startedAt} onMinimize={onMinimize} muted={muted} />
      <CallStage avatar={avatar} connectedLabel={connectedLabel} muted={muted} />
      <CallControlsDrawer
        transcript={transcript}
        muted={muted}
        onMutedChange={(next) => {
          setMuted(next)
          onMutedChange?.(next)
        }}
        speakerOn={speakerOn}
        onSpeakerOnChange={(next) => {
          setSpeakerOn(next)
          onSpeakerOnChange?.(next)
        }}
        onAudioSetup={onAudioSetup}
        onHangUp={onHangUp}
      />
    </div>
  )
}

export { CallScreen }
export type { CallScreenProps }
