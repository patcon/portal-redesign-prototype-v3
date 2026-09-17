# Plan — portal redesign prototype v3

**Demo: 2026-09-17, 9:30am.** Written ~3:55am the same morning.
This document is written to be sufficient on its own: a fresh session should be
able to start at Slice 0 without re-deriving anything below.

---

## 1. Why this exists

Patrick (Dembrane) is building a prototype on the sly, with other work deferred,
to show the **technical cofounder** by 9:30am that Dembrane's participant portal
can be rebuilt on Cloudflare Agents with dramatically less machinery.

- **The sell is simplicity.** Same product, same screens, same copy — far less
  code and far fewer dependencies. Like-for-like is what kills the "but ours
  already works" rebuttal.
- **Offline is the closer, not the pitch.** Running an event from a laptop on a
  router is a capability the current portal lacks, but it is a bonus.
- **He is also convincing himself.** His stated worry is that the gains won't
  *look* obvious. So making the gains legible is a first-class requirement, not
  a nice-to-have — see Slice 6.

### Confirmed intent (agreed in interview, do not relitigate)

| | |
|---|---|
| **Outcome** | Host route spawns a private host thread with a QR code; scanning spawns a group chat; onboarding happens *as agent messages*; a call records and transcribes; the agent can read the transcript; the host can ask about sub-chats |
| **User** | Patrick, demoing to Dembrane's technical cofounder |
| **Why now** | No sign-off yet, work deferred, window closes this morning |
| **Success** | Cofounder sees the same participant flow they specced, working, and the "how" is obviously smaller |
| **Constraint** | ~6h, builder is unslept, local `wrangler dev`, no Dembrane cloud |
| **Out of scope** | See §6 |

### The number that does the work

| | Existing (`dembrane-echo` frontend) | This prototype |
|---|---|---|
| Runtime deps | 78 (+39 dev) | target ~8 |
| Participant components | 13,299 LOC | target < 1,000 LOC |

Reference point: `examples/next/routing` implements an entire multi-chat routed
app in **656 LOC** with 5 runtime deps. Measure ours the same way at the end.

---

## 2. Architecture

Lifted from `examples/next/routing`, which the SDK documents as the recommended
shape for "many chats per owner" — explicitly *over* facets/dynamic agents,
because chats need their own alarms and accrue without bound. **This was not a
design choice we made; it is the framework's own guidance.** That matters: the
thesis is "the framework tells you how to build this," so inventing an
architecture would argue against our own case.

```
ProjectHub "event-id"  (plain DurableObject)     GroupChat  (one Agent per table)
┌──────────────────────────────────┐             ┌─────────────────────────────┐
│ RoutedAgents route "chats"       │  forward    │ own SQLite: messages         │
│  id → opaque physical name,      │────────────▶│ own WebSocket, own alarms    │
│  title, lastMessage, seq         │             │ extends ChatAgent            │
│ WebSockets callables             │◀────────────│ transcript accumulation      │
└──────────────────────────────────┘   push      └─────────────────────────────┘
  createChat / listChats / searchChats              onTranscript / tools
```

### Naming (decided)

| Name | What it is |
|---|---|
| `ProjectHub` | Plain `DurableObject`, one per event/project. Owns the catalog of chats, routes to them, holds pushed metadata for listing and search. **Not** an `Agent`. |
| `GroupChat` | One routed Agent per table/group. Extends `ChatAgent`. |
| `ChatAgent` | Our composed base class: `withVoiceInput(AIChatAgent)`. Both `GroupChat` and the host's private thread extend it. |
| `HostThread` | The host's private chat. Extends `ChatAgent`, owned and routed by `ProjectHub` like any other chat, flagged as the admin one. |

#### Why `ProjectHub` is *not* itself a chat agent

The host does have a thread to render — but that thread is a chat the hub owns,
not the hub itself. Keeping them separate, for three reasons:

1. **Contention.** Every join, every metadata push from every table, and every
   listing/search routes through the hub. If the hub also ran a streaming LLM
   turn for the host, all of that would contend with inference on one Durable
   Object. The example's stated reason for a plain-DO hub is that chat frames
   never wake it.
2. **One chat implementation, not two.** `HostThread extends ChatAgent` inherits
   persistence, streaming, tools and voice. A chat-agent hub means writing a
   second, subtly different chat path — more code, which argues against the
   thesis.
3. **The cross-chat question stays clean.** Slice 5 becomes a tool on
   `HostThread` that calls `env.ProjectHub.getByName(eventId)` — the same
   pattern `GroupChat` already uses to push metadata back.

`RoutedAgents`, `WebSockets`, `Lifecycle` are SDK capability classes — those
names come from `agents/*` and are not ours to rename.

In `examples/next/routing` these are called `UserHub` and `ChatAgent`; rename on
copy.

### Deltas we must add to the example

1. **The example has no model.** Its assistant reply is a literal echo. We
   compose `AIChatAgent` (from `@cloudflare/ai-chat`) as the routed target.
   `RoutedAgents` requires targets to extend `Agent`; `AIChatAgent` does, so this
   should work — but no example on disk does both. **This is the first real
   risk.** See §5.
2. **Voice.** `withVoiceInput` mixin from `agents/voice`, transcriber
   `WorkersAINova3STT(this.env.AI)`. Copy from `examples/voice-input`.
3. **Model wiring.** Lift `examples/playground/src/model.ts` verbatim — already
   OpenRouter-with-Workers-AI-fallback, written by Patrick on this branch.

### How the host agent sees and touches the other chats

Two tiers, both already plumbed by the example. The choice is not a later
concern — **Slice 3 decides it by what it pushes.**

| | Mechanism | Cost | Use for |
|---|---|---|---|
| **Breadth** | `GroupChat` pushes into `ChatMeta` via `recordChatActivity` on every message; host reads hub state only | No chat wakes; scales to a full room | "What's happening across the tables?" |
| **Depth** | `chats.get(id)` returns a typed `GroupChat` stub; RPC straight into it | Wakes that one chat | "Tell me more about table 3" |

**Slice 3 must widen `ChatMeta`** beyond `{title, lastMessage, seq}` to carry a
rolling transcript excerpt (or running summary), or the host can only reach
transcripts by drilling in one table at a time. The existing `seq` fence in
`recordChatActivity` already makes streaming pushes safe against reordering.

**Writing into another chat** (later, not today): the hub already RPCs into a
chat during `createChat` (`chat.init(...)`). The same typed stub reaches a
`GroupChat` method that calls `saveMessages` — which persists *and* broadcasts,
so a phone at that table sees the message arrive live. Path:
`HostThread` tool → `env.ProjectHub.getByName(event)` → `chats.get(id)` → inject.

This is the `pizzo` "one document, two hands" pattern from `docs/BRAINSTORM.md` — the
agent acting on the same surface the user acts on — and it is also the seam where
admin-only forwarded attachments eventually live. Nothing here forecloses it.

### Known consequences, accepted

- **Workers AI proxies to remote even under `wrangler dev`.** STT will not run
  with the laptop unplugged. Offline was demoted to a bonus, and the local-Whisper
  seam is one `Transcriber` implementation away (there's a whisperfile at
  `examples/voice-input/.whisperfile/`). Correct trade for today — but **say it
  out loud at the demo before anyone asks.**
- **Zero access control.** Anyone with a hub id can route into any group chat.
  Access is derived from the route and nothing else. Agreed out of scope.

---

## 3. Key APIs, already verified on disk

```ts
// Hub — plain DO with capabilities (examples/next/routing/src/index.ts)
export class ProjectHub extends DurableObject<Env> {
  readonly chats = new RoutedAgents<GroupChat, ChatMeta>({
    namespace: this.env.GroupChat,
    route: "chats"          // claims /chats/{id}/... before onRequest sees it
  });
  readonly webSockets = new WebSockets({ callables: new HubCallables(this) });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.chats)        // install order matters: routing first
    .use(this.webSockets);
}
```

```ts
// Voice (examples/voice-input/src/server.ts)
import { withVoiceInput, WorkersAINova3STT } from "agents/voice";
const InputAgent = withVoiceInput(AIChatAgent);
export class ChatAgent extends InputAgent<Env> {
  transcriber = new WorkersAINova3STT(this.env.AI);
  onTranscript(text, connection) { /* accumulate */ }
}
```

```tsx
// Client (agents/voice/react)
const { transcript, interimTranscript, isListening, start, stop, clear } =
  useVoiceInput({ agent: "GroupChat" });
```

```ts
// Model (examples/playground/src/model.ts) — copy as-is
const OPENROUTER_MODEL = "openrouter/free";
if (env.OPENROUTER_API_KEY) return createOpenRouter({ apiKey: ... })(OPENROUTER_MODEL);
return createWorkersAI({ binding: env.AI })("@cf/moonshotai/kimi-k2.7-code");
```

Routing URLs:

| URL | Handled by |
|---|---|
| `/agents/project-hub/{event}` | `ProjectHub`, JSON catalog |
| `/agents/project-hub/{event}/chats/{id}` | the `GroupChat` behind that entry |

Client connects to the hub with `useAgent`, and to each chat with its own
`useAgent` via `basePath` through the hub's route.

---

## 4. Slices

Each is independently demoable. Whenever we stop, there is something to show.

### Slice 0 — Scaffold (~30m)

- Copy `~/repos/dembrane/agents/examples/next/routing` into this directory.
- ~~**Do not use workspace deps.**~~ **Wrong — corrected in flight.** Local
  `agents` reports `0.23.0` but carries unreleased commits on top of the npm
  release (notably "WebSockets owns the Agent protocol's state sync and
  connection flags"). Against published `agents@0.23.0` the hub's WebSocket
  upgrade returns an empty reply and `createChat` times out. The example only
  works against the local build, so depend on it directly:
  `"agents": "link:../agents/packages/agents"` and
  `"@cloudflare/ai-chat": "link:../agents/packages/ai-chat"`.
  Three consequences of linking, all handled:
  - `@babel/plugin-proposal-decorators` must be a local devDependency (the
    monorepo root was providing it for `@callable()`).
  - `@types/node` must be a local devDependency (`agents/tsconfig` asks for it).
  - `vite.config.ts` needs `resolve.dedupe: ["react", "react-dom"]`, or the
    symlink gives the app two copies of React and `App` throws on `useMemo`.
- Rename `UserHub` → `ProjectHub`, `ChatAgent` → `GroupChat` (then introduce our
  own `ChatAgent` base in Slice 2). Update `wrangler.jsonc` DO bindings **and**
  the `migrations` tag `v1` `new_sqlite_classes` to match.
- Add `"ai": { "binding": "AI" }` to `wrangler.jsonc` for Workers AI.
- `pnpm install && pnpm start`.
- Removed from the copied example: `src/tests/` (its vitest config reaches
  back into monorepo-internal scripts) and the `?transport=capnweb` toggle in
  `client.tsx` (example instrumentation, not something the demo shows).
- **Done when:** browser loads, a chat can be created, it echoes.
  ✅ **Verified 2026-09-17 ~04:25** on `localhost:5173`: chat created, message
  sent, echo returned, sidebar showed the pushed title and last message.

### Slice 1 — Host thread + QR join (~60m)

- `/host` (or `/h/{event}`) renders the host's private thread.
- First message in the host thread offers/exposes a QR code encoding the join URL.
- Scanning creates a new `GroupChat` via the hub and lands the phone in it.
- **Done when:** a phone on the router scans and lands in a live group chat.
  ⚠️ **Partially met — verified on `localhost` only.** The join flow itself is
  proven: `/join/{event}` creates a `GroupChat` and redirects to
  `/g/{event}/{chatId}`, the table talks, and the host console lists it from hub
  metadata alone. The QR encodes `location.origin`, so on localhost it encodes a
  URL no phone can reach.
- **The phone path is blocked on an insecure-context problem, not on our code.**
  Served over plain HTTP on a LAN address, browsers withhold
  `crypto.randomUUID`, which `agents`' own client (`src/client.ts:789`) calls to
  mint connection ids — so the socket never opens and the hub stays empty.
  Confirmed against `http://192.168.2.22:5173`. Three ways out when wanted:
  a ~10-line `crypto.randomUUID` shim imported first (no cert warning, works on
  any phone); HTTPS via a self-signed cert (phones must tap through a warning);
  or a tunnel such as `cloudflared`. Deferred by Patrick: "just use localhost".
- Also fixed here: the example nested the delete control inside each row's own
  `<button>`, which is invalid HTML and left delete unreachable by keyboard.
  Rows are now a row `<div>` with the two controls as siblings.

### Slice 2 — OpenRouter + onboarding-as-messages (~75m)

- Introduce `ChatAgent` = `withVoiceInput(AIChatAgent)`; `GroupChat extends ChatAgent`.
- Copy `model.ts`; needs `@openrouter/ai-sdk-provider@^3`, `workers-ai-provider@^4`, `ai@^7`.
- **Needs `OPENROUTER_API_KEY` in `.dev.vars`** — none exists yet; Patrick must
  supply one. Without it, `model.ts` silently falls back to Workers AI, which is
  an acceptable demo path.
- Onboarding flow as agent messages, using echo's copy: welcome → intent choice →
  number of speakers → privacy consent → table name → mic check → go live.
  **Text answers only**, no widget buttons.
- **Done when:** a participant completes onboarding by typing.

### Slice 3 — The call (~90m, highest risk)

- `withVoiceInput` + `WorkersAINova3STT`; transcript accumulates during the call.
- Ending the call posts a voice-call message into the thread carrying the transcript.
- **Widen `ChatMeta` to push a rolling transcript excerpt to the hub** as it
  accumulates, so the host can read across tables without waking them (see §2).
- **Done when:** speak, stop, see the transcript in the thread.

### Slice 4 — Agent reads the transcript (~30m)

- **Done when:** "what did we just discuss?" is answered from the transcript.

### Slice 5 — Host cross-chat view (~45m)

- A tool over the hub's `searchChats` / `listChats` metadata, so the host thread
  can answer "what's happening at the tables?" without waking any chat.
- **Done when:** the host thread answers a cross-table question.

### Slice 6 — Measure (~15m) — NOT OPTIONAL

- Count our LOC and dependency count; fill in the table in §1; write it into the
  README. **The numbers are the argument.** Without them this is just another
  chat app, and the one thing Patrick is worried about — that the gains won't
  look obvious — comes true.

### Cut line — 6:30am

If Slice 3 is not working by 6:30am: stub transcription with a canned transcript
and move to 4, 5, 6. A demo that ends strong beats one that dies mid-recording.
After that, Slice 5 is the next to sacrifice. Slice 6 is never cut.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| `AIChatAgent` as a `RoutedAgents` target is unproven on disk | Lands in Slice 2, early. Fallback: plain `Agent` calling `streamText` directly — loses message persistence niceties, loses nothing the demo shows. |
| Workers AI STT latency/quality over a phone mic | Cut line at 6:30am; canned transcript fallback. |
| No OpenRouter key | `model.ts` falls back to Workers AI automatically. Not a blocker. |
| Builder has not slept | Slice order is strictly value-descending. Stopping anywhere still leaves a demo. |

---

## 6. Explicitly not building

Local Whisper · widget buttons (numeric keypad, checkbox, single-select — text
answers only) · auth / access control · attachments and admin-only messages ·
per-activity Durable Objects · participant scope · pixel-accurate Storybook
styling · anything from `pizzo`'s think-agent architecture.

---

## 7. Source material on disk

| Path | For |
|---|---|
| `~/repos/dembrane/agents` (branch `patcon/playground-openrouter`) | the SDK monorepo |
| `…/examples/next/routing` | the architecture — copy this |
| `…/examples/voice-input` | STT mixin, `useVoiceInput`, local whisperfile |
| `…/examples/playground/src/model.ts` | OpenRouter wiring — copy verbatim |
| `~/repos/dembrane-echo` (branch `feat/storybook`) | existing portal |
| `…/echo/frontend/src/components/participant` | onboarding flow + copy |
| `~/repos/dembrane-portal-redesign` | earlier UI attempts |
| `~/repos/pizzo` | inspiration only; not used today |
| `docs/BRAINSTORM.md` | original raw notes, incl. later-stage goals |

Relevant skills available in-session: `agents-sdk`, `cloudflare`,
`durable-objects`, `wrangler`.
