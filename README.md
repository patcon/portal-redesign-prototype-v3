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

Opening `/` mints a random event id and sends you to that event's host console.
Serve on a LAN address (`pnpm start` already passes `--host`) and the QR code
encodes that address, so an event runs from a laptop on a local router with no
internet.

## Routes

Every route hangs off an event id.

| Route                              | Who      | What                                                            |
| ---------------------------------- | -------- | --------------------------------------------------------------- |
| `/events/{eventId}/secret`         | the host | Console: private host thread, QR code, every conversation       |
| `/events/{eventId}`                | a device | What the QR code points at; spawns a conversation and redirects |
| `/events/{eventId}/group/{chatId}` | a device | One conversation's own thread                                   |

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
read — which is how "what's happening at the tables?" costs one Durable Object
read instead of N.

The host's private thread is a `GroupChat` like any other, distinguished only
by `kind: "host"`. One chat implementation, not two.

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

| Command             | Does                                        |
| ------------------- | ------------------------------------------- |
| `pnpm start`        | Vite dev server, bound to the LAN           |
| `pnpm test`         | Vitest                                      |
| `pnpm typecheck`    | `tsc --noEmit`                              |
| `pnpm lint`         | oxlint (import, react, jsx-a11y, vitest)    |
| `pnpm format`       | oxfmt check                                 |
| `pnpm format:write` | oxfmt fix                                   |
| `pnpm types`        | Regenerate `env.d.ts` from `wrangler.jsonc` |
| `pnpm deploy`       | Build and `wrangler deploy`                 |

## Size

The point of the rebuild is how little there is of it. Measured on this repo:

|                           |                  |
| ------------------------- | ---------------- |
| Runtime dependencies      | 17 (plus 15 dev) |
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
  recording, but no message is written when the call ends. `onTranscript` only
  fires on a _finalized_ transcript, and `onCallEnd` returns silently when none
  arrived — which is also what happens when the Nova 3 socket dies mid-call
  under `vite dev`. Undiagnosed; `whisper-local` is the workaround to try.
- **No authentication.** See Routes above.

## Background

`docs/PLAN.md` and `docs/BRAINSTORM.md` are frozen records of how this
prototype was specced and built. They are history, not current documentation —
where they disagree with this README or the code, they are wrong.
