// Worker entry point — routes incoming fetch() and scheduled() events to the
// singleton GatewayDO, which owns the persistent Discord gateway WebSocket.
// Re-exports the DO class so Wrangler can bind it.

import { GatewayDO } from "./gateway";

export { GatewayDO };

/** Worker bindings: the DO binding name matches wrangler.toml + the secret. */
interface Env {
  GATEWAY: DurableObjectNamespace;
  DISCORD_TOKEN: string;
  /** Discord channel id for the buys/sells feed. Optional — empty = disabled. */
  BUYS_CHANNEL_ID?: string;
}

/** Stable id for the singleton DO instance. */
const SINGLETON_ID = "primary";

function getGatewayStub(env: Env): DurableObjectStub {
  const id = env.GATEWAY.idFromName(SINGLETON_ID);
  return env.GATEWAY.get(id);
}

/**
 * GET /  -> ensures the DO has an open gateway connection and returns "ok".
 * Any HTTP method works; a simple `curl` is enough to bootstrap the bot.
 */
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const stub = getGatewayStub(env);
    // Bootstrap the DO's gateway connection. The DO is a singleton; repeated
    // calls are a cheap no-op once the WebSocket is open.
    return stub.fetch("https://do/bootstrap");
  },

  /**
   * Cron trigger (every 1 min). Wakes the DO so its alarm() can heartbeat and
   * push presence — and re-bootstraps the WebSocket if it ever dropped.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(getGatewayStub(env).fetch("https://do/watchdog"));
  },
} satisfies ExportedHandler<Env>;
