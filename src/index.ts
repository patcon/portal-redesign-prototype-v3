/**
 * Worker entry point. The Durable Object classes are re-exported here because
 * `wrangler.jsonc` names this module as `main`, and the runtime discovers the
 * classes named in its bindings among this module's exports.
 */

import { routeAgentRequest } from "agents";

export { GroupChat } from "./server/group-chat";
export { ProjectHub } from "./server/project-hub";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Routes both /agents/project-hub/{user} and the forwarded
    // /agents/project-hub/{user}/chats/{id}/... paths: RoutedAgents claims the
    // latter from inside the hub once the request reaches it.
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
