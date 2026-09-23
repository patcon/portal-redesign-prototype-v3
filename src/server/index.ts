/**
 * Worker entry point. The Durable Object classes are re-exported here because
 * `wrangler.jsonc` names this module as `main`, and the runtime discovers the
 * classes named in its bindings among this module's exports.
 */

import { routeAgentRequest } from "agents";
import { handleRecording, parseRecordingPath } from "./recording-route";

export { GroupChat } from "./group-chat";
export { ProjectHub } from "./project-hub";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Recorded call audio, streamed out of R2. Claimed before the agent router
    // because it is not an agent request at all — the conversation's object is
    // asked for the manifest and nothing more, so the bytes go R2 → client
    // without a long recording ever passing through a Durable Object.
    const recording = parseRecordingPath(new URL(request.url).pathname);
    if (recording) return handleRecording(recording, request, env);

    // Routes both /agents/project-hub/{user} and the forwarded
    // /agents/project-hub/{user}/chats/{id}/... paths: RoutedAgents claims the
    // latter from inside the hub once the request reaches it.
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
