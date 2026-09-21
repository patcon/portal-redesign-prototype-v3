/**
 * Onboarding, as agent messages rather than a card deck.
 *
 * The copy is Dembrane's own, lifted from the existing portal's onboarding
 * cards (`echo/frontend/src/components/participant/hooks/useOnboardingCards.ts`
 * and `ParticipantOnboardingCards.tsx`). Keeping the words identical is the
 * point: the comparison is meant to be like-for-like, so the only thing that
 * differs is how much machinery sits behind them.
 *
 * In the existing portal this is seven slides with per-slide components, a
 * carousel, checkbox state, and a microphone-test widget. Here it is a prompt.
 */

/** The opening message, posted before the participant has said anything. */
export const WELCOME_MESSAGE =
  "Welcome to dembrane! Record your voice to answer questions and make an impact.\n\n" +
  "Before we start, a few quick questions — just type your answers.\n\n" +
  "First: are you recording on your own, or as a group?";

export const ONBOARDING_INSTRUCTIONS = `
You are the dembrane portal assistant for one conversation at a hosted event.
You are warm, brief, and never chatty. One question per message, and never more
than three sentences.

Walk the participant through onboarding in this order, using this copy. Ask one
step at a time and wait for a typed answer before moving on. Accept answers in
any wording — never make someone repeat themselves because of formatting.

1. Solo or in a group — "dembrane is more fun in groups!" If they say they are
   on their own, or anything else that means they are not a group ("just me",
   "solo", "no", "not a group"), call the \`setParticipantCount\` tool with 1
   and move on without asking for a number.
2. If a group, ask how many people are in the conversation. Any number is fine.
   Call \`setParticipantCount\` with it as soon as they answer.
3. How it works — "You'll receive the questions once in the recording portal."
   Then ask if they are happy to continue.
4. Privacy — "As the recorder, you are in control of what you share." Ask them
   to confirm they consent to being recorded before going any further. If they
   decline, stop and tell them the host can take their input another way.
5. Ask what to call this conversation, so the host can tell the conversations
   apart. Examples like "Group 1" or "Kitchen crew" are fine. As soon as they
   answer, call the \`setConversationName\` tool with the name. If they rename
   the conversation later, call it again.
6. Microphone check — "Let's Make Sure We Can Hear You." Tell them to press the
   record button when ready.
7. Ready to Begin? — confirm they are set up, restate the conversation name, and
   stop asking questions.

Rules:
- Ask for typed answers only. Never offer buttons, numbered menus to tap, or
  checkboxes; this portal has no widgets.
- Do not invent questions for the discussion itself. The host supplies those.
- Once onboarding is done, answer normally and stay out of the way.
`.trim();

/**
 * The conversation's own state, as the model sees it at the top of each turn.
 *
 * Without this the agent is blind to its own `state`: the only trace of a
 * recorded participant count is a `tool-result` part buried in the history, so
 * a small model cannot tell "already set" from "never set" and sets it again,
 * every turn, until the turn runs out of steps with no text written.
 *
 * The shape follows pizzo's "Current song:" block
 * (`agents/studio/agents/song/agent.ts`): a labelled dash list rather than a
 * JSON object, rebuilt from state on every turn, with absent values spelled
 * out in words. A `null` in JSON reads as missing data; "not yet chosen" reads
 * as a fact about the conversation, which is what it is.
 */
export function conversationStatus(
  state: { name: string | null; participants: number | null },
  options: { hasTranscript: boolean },
): string {
  return [
    "Current conversation:",
    `- Name: ${state.name ?? "not yet chosen"}`,
    `- Participants: ${state.participants ?? "not yet recorded"}`,
    `- Voice recording: ${
      options.hasTranscript ? "at least one call recorded" : "nothing recorded yet"
    }`,
    "",
    "These are already recorded. Do not call a tool to set a value that is",
    "already correct above — only when it is missing, or the participants ask",
    "you to change it.",
  ]
    .join("\n")
    .trimEnd();
}
