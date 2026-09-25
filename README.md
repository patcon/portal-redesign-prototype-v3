# Dembrane participant portal — prototype v3

A rebuild of Dembrane's participant portal on [Cloudflare Agents]. A host opens
a console, shows a QR code, and every device that scans it gets its own
conversation — its own Durable Object, its own chat thread, its own voice
calls. The host can read and search across all of them without waking any of
them.

[Cloudflare Agents]: https://developers.cloudflare.com/agents/

```sh
pnpm install
pnpm start          # http://localhost:5173 → redirects to a fresh event
```

`pnpm install` needs a checkout of [Cloudflare's `agents` monorepo] beside this
one, at `../agents`: this prototype tracks unreleased work in the Agents SDK, so
`agents` and `@cloudflare/ai-chat` are `link:` dependencies rather than versions
on npm. Without it, install fails.

[Cloudflare's `agents` monorepo]: https://github.com/cloudflare/agents

Opening `/` mints a random event id and sends you to that event's host console.
Serve on a LAN address (`pnpm start` already passes `--host`) and the QR code
encodes that address, so an event runs from a laptop on a local router with no
internet.

### Reaching it from phones over a tunnel

Phones only allow the microphone on a secure origin, so a plain `http://` LAN
address can chat but cannot call. For that, run the dev server behind a
Cloudflare quick tunnel:

```sh
CF_TUNNEL=1 pnpm start   # prints a https://….trycloudflare.com URL
```

Without `CF_TUNNEL`, press `t` + enter in the running server to open one on
demand. The QR code is built from the address the console is open on, so open
the host console **on the tunnel URL** and the code sends devices there too.
A quick tunnel is public to anyone who has the URL, and there is no
authentication (see Routes).

To run the local transcriber and the tunnelled app together:

```sh
pnpm start:all   # whisper (pnpm stt:server) + app (pnpm start, CF_TUNNEL=1)
```

That is [mprocs], a dev dependency, reading `mprocs.yaml`.

The `whisper` process expects `pnpm stt:setup` to have run once (see
Speech-to-text).

[mprocs]: https://github.com/pvolok/mprocs

## What it does

### For participants

- A familiar messenger interface — thread, composer and voice notes shaped
  the way the ones on everybody's phone already are.
- Conversational onboarding: the conversation asks what to call itself and
  names itself from the answer, rather than opening with a form.
- **Recording is a phone call.** Place a call to the platform, leave the phone
  on the table, and talk. Mute whenever you like: the recording and the
  transcript both mark where the break was and how long it lasted.
- Live transcription of the conversation as it is spoken.
- Play the call back or read its transcript afterwards, from the thread itself.

### For hosts

- A console of its own, with every conversation in the event in one view.
- Read any conversation, and drop a message into it.
- Read transcripts as they stream in _(coming soon — today the host sees the
  excerpt each conversation pushes, not a live feed)_.
- Listen in on a call still in progress, in near-realtime.
- Ask the host thread's chatbot about what is being said across the
  conversations — it has tools for listing and searching them.
- Play back the audio or read the transcript for any conversation.

## Routes

Every route hangs off an event id.

| Route                              | Who      | What                                                            |
| ---------------------------------- | -------- | --------------------------------------------------------------- |
| `/events/{eventId}/secret`         | the host | Console: private host thread, QR code, every conversation       |
| `/events/{eventId}`                | a device | What the QR code points at; spawns a conversation and redirects |
| `/events/{eventId}/group/{chatId}` | a device | One conversation's own thread                                   |

Two more are the Worker's rather than the app's, and are listed in
`run_worker_first` so the SPA does not swallow them:

| Route                                               | What                                             |
| --------------------------------------------------- | ------------------------------------------------ |
| `/recordings/{eventId}/{chatId}/{recordingId}.wav`  | A call's audio, assembled from R2 on the way out |
| `/recordings/{eventId}/{chatId}/{recordingId}.json` | Its length and waveform, for the voice note      |

Access is decided by the route alone — there is no authentication. Anyone with
an event id can reach its host console. That is deliberate for a prototype and
must change before this is deployed anywhere real.

## Architecture

One `ProjectHub` Durable Object per event owns a catalog of conversations and
routes into them. Each conversation is its own `GroupChat` Durable Object, with
its own SQLite, alarms and placement.

```
ProjectHub (one per event, plain DurableObject)   GroupChat (one per conversation)
┌──────────────────────────────────┐          ┌───────────────────────────────┐
│ RoutedAgents, route "chats"      │ forward  │ messages, onboarding, tools   │
│   id → opaque physical name      │─────────▶│ voice calls + transcript      │
│   + metadata: title, lastMessage │          │ own SQLite, alarms, placement │
│     transcript, seq              │◀─────────│ owns its own WebSocket        │
│ WebSockets → HubCallables        │   push   └───────────────────────────────┘
└──────────────────────────────────┘
  listChats / searchChats / deleteChat
```

The hub never wakes a conversation to list or search it. Each conversation
pushes its own title, latest message and call transcript back into the hub
(`recordChatActivity`), fenced by a per-chat sequence number inside
`blockConcurrencyWhile` so a delayed push cannot overwrite a newer one. That
pushed metadata is what the sidebar renders and what the host's agent tools
read — which is how "what's happening in the conversations?" costs one Durable
Object read instead of N.

The host's private thread is a `GroupChat` like any other, distinguished only
by `kind: "host"`. One chat implementation, not two.

### Recorded call audio

`agents/voice` sends raw headerless PCM — 16 kHz mono 16-bit, about 32 KB/s —
so a recording is just bytes in order, with no container or codec anywhere.
That is what makes the rest of this small.

```
browser ──PCM frames──▶ CallTranscriber.feed ──▶ provider (transcript)
                                │
                                ▼
                        rec_pending (SQLite, ~2s)
                                │ flush
                                ▼
              R2  recordings/{chatId}/{recordingId}/00000.pcm
                                │
   GET …/{recordingId}.wav ─────┴─▶ RIFF header + segments, streamed R2 → client
```

The audio is tapped in `CallTranscriber`, which already wrapped every frame on
its way to the speech-to-text provider — `withVoiceInput` offers no hook for raw
audio, and this needs no fork of the SDK. Frames are staged in the
conversation's own SQLite and written to R2 a couple of seconds at a time, so an
eviction mid-call loses only the unflushed tail. A recording is identified by
the call's **connection**, not its transcriber session: the WebSocket survives an
eviction and the session does not.

Nothing is stored in WAV form. The 44-byte header is made per request, which is
what lets the same route serve a call still in progress — it declares an unknown
length and keeps reading until the recording ends. The cost is that a live
recording cannot be seeked and reports no duration; once it ends the route
serves a real length, `Accept-Ranges`, and the client asks for a fresh url so the
player picks the seekable version up.

A call therefore leaves two messages in the thread: a voice note when it opens,
and the transcript card when it ends. The voice note is chatcn's own `voice`
message shape, so it needed no new render branch — but chatcn's player was a
mock that ignored `voice.url` and faked its progress with a timer, and now
drives a real `<audio>`. See the note above `ChatVoiceMessage`.

Retention is bucket configuration rather than Worker configuration, so it cannot
live in `wrangler.jsonc`: `scripts/provision-r2.sh` creates the bucket and its
90-day lifecycle rule. Local development needs none of it — `vite dev` simulates
the binding.

## Layout

The directory is the runtime boundary.

```
src/
  server/                    runs on the Worker
    index.ts                 entry: DO re-exports + fetch  (wrangler `main`)
    group-chat.ts            a conversation: messages, tools, voice, hub pushes
    project-hub.ts           the event catalog, routing, search
    validate.ts              guards on the browser-reachable surface
    model.ts                 chat model selection
    stt/                     transcriber selection + local whisperfile
    prompts/                 onboarding and host system instructions
  components/                runs in the browser
    HostView  ConversationsShell  ChatPane  GroupView
    JoinView  JoinCode  ShareLink  ModeToggle
    adapt.ts                 agent wire shapes → design-system props
    ui/{shadcn,chatcn}/      vendored — see below
    dembrane/                vendored — see below
  hooks/                     useHub  useRoute  useCall
  lib/utils.ts               vendored — re-exports `cn`
  client.tsx                 entry: route switch + createRoot
  router.ts  shared.ts  types.ts  styles.css     shared by both sides
```

Nothing under `server/` reaches the browser bundle, and the wire contract lives
in exactly one place (`types.ts`, `shared.ts`) rather than being described twice.

### Vendored components

`src/components/ui/**`, `src/components/dembrane/**` and `src/lib/utils.ts` are
one-way copies from [`dembrane-portal-redesign`], the Storybook-first repo where
the interface is designed. They are not edited here: `oxfmt` and `oxlint` ignore
them so they stay byte-identical to upstream and a re-copy is a plain overwrite.
Everything that wires them to the agents — the adapters in `adapt.ts`, the
responsive shell in `ConversationsShell.tsx` — lives outside those directories
for exactly that reason.

They import through the `@/` alias, declared in both `tsconfig.json` and
`vite.config.ts`.

[`dembrane-portal-redesign`]: https://github.com/Dembrane/portal-redesign

## Configuration

Copy `.dev.vars.sample` to `.dev.vars`. Both providers below default to
something that works with no keys at all. Changing `.dev.vars` needs a restart
of `pnpm start`; the host console header shows which model and transcriber are
live.

### Chat model

`MODEL_PROVIDER` picks the chat model: `workers-ai` (default, Kimi K2 through
the AI binding, no keys) or `openrouter` (needs `OPENROUTER_API_KEY`;
`OPENROUTER_MODEL` defaults to `openrouter/free`, capped at 50 requests a day).

### Speech-to-text

Conversation calls are transcribed by the provider named in `STT_PROVIDER`.

| `STT_PROVIDER`    | Runs on                     | Trade-off                                                                                                                                                                |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nova3` (default) | Workers AI, Deepgram Nova 3 | Best quality, live interim text. Under `vite dev` its WebSocket goes through the AI binding's remote proxy, which has failed mid-session ("did not return a WebSocket"). |
| `flux`            | Workers AI, Deepgram Flux   | Same WebSocket path and caveat as `nova3`.                                                                                                                               |
| `whisper-local`   | whisperfile on this machine | Offline, no Cloudflare calls. Lower quality, no interim text; an utterance lands after ~800ms of silence.                                                                |

To run fully offline:

```sh
pnpm stt:setup    # once: downloads whisper-tiny.en.llamafile (~90MB)
pnpm stt:server   # leave running alongside `pnpm start`
```

## Scripts

| Command                  | Does                                        |
| ------------------------ | ------------------------------------------- |
| `pnpm start`             | Vite dev server, bound to the LAN           |
| `CF_TUNNEL=1 pnpm start` | …and behind a public quick tunnel           |
| `pnpm start:all`         | Local whisper + tunnelled app, via mprocs   |
| `pnpm test`              | Vitest                                      |
| `pnpm typecheck`         | `tsc --noEmit`                              |
| `pnpm lint`              | oxlint (import, react, jsx-a11y, vitest)    |
| `pnpm format`            | oxfmt check                                 |
| `pnpm format:write`      | oxfmt fix                                   |
| `pnpm types`             | Regenerate `env.d.ts` from `wrangler.jsonc` |
| `pnpm deploy`            | Build and `wrangler deploy`                 |

## Size

The point of the rebuild is how little there is of it. Measured on this repo:

|                           |                  |
| ------------------------- | ---------------- |
| Runtime dependencies      | 17 (plus 19 dev) |
| Browser code, this repo's | 1,249 lines      |
| Worker code               | 1,044 lines      |
| Vendored component source | 4,868 lines      |

Counts exclude tests. The last row is the honest asterisk on the others: the
design system arrived as source copied into the tree rather than as packages, so
it is code this repo carries and must read, even though it is not code written
here and not a dependency to resolve. The first row still means what it says —
17 things `pnpm install` fetches.

For the comparison against the existing `dembrane-echo` frontend that motivated
this, see [`docs/PLAN.md`](docs/PLAN.md) — those figures are quoted from that
document and were not re-measured here.

## Known issues

- **A call's transcript may not reach the thread.** Interim text appears while
  recording, but the message written when the call ends can be empty.
  `onTranscript` only fires on a _finalized_ transcript, and none arrives when
  the Nova 3 socket dies mid-call under `vite dev`. Undiagnosed; `whisper-local`
  is the workaround to try. The audio is no longer lost with it — a call the
  provider could not hear still writes its message, and the voice note plays.
- **A resumed call forgets what it already heard.** `onCallStart` runs again
  after an eviction mid-call and resets that connection's utterances, so the
  transcript keeps only what was said after the object woke. The recording does
  not have this gap.
- **Listening to a call in progress starts from its beginning.** An unknown-length
  stream cannot be seeked, so there is no way to jump to the live edge.
- **No authentication.** See Routes above.

## Background

`docs/PLAN.md` and `docs/BRAINSTORM.md` are frozen records of how this
prototype was specced and built. They are history, not current documentation —
where they disagree with this README or the code, they are wrong.
