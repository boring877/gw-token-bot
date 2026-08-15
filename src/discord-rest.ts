// Thin Discord REST helper for posting messages with embeds. Deliberately
// minimal (no discord.js) — we only need to POST to a channel. Handles 429
// rate limits by reading retry_after and sleeping.

const API_BASE = "https://discord.com/api/v10";

/** Maximum retries on 429/5xx before giving up. */
const MAX_RETRIES = 3;

/** Payload shape we send to POST /channels/{id}/messages. */
export interface DiscordMessagePayload {
  /** Message body (plain text). Optional if embeds are present. */
  content?: string;
  /** Rich embeds (we use one per swap message, colored buy/sell). */
  embeds?: DiscordEmbed[];
}

/** Subset of the Discord embed schema we use. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number; // RGB as a single int: (r<<16) | (g<<8) | b
  image?: { url: string };
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string; // ISO 8601
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Post a message to a Discord channel. Retries on 429 (honoring retry_after)
 * and 5xx. Throws on persistent failure so the caller can log and move on —
 * a missed swap message is not fatal.
 *
 * @param token  Bot token (same one used for the gateway).
 * @param channelId  Target channel id (the #gw-buys channel).
 * @param payload  Message content + embeds.
 */
export async function postChannelMessage(
  token: string,
  channelId: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  const url = `${API_BASE}/channels/${channelId}/messages`;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      // Network error — back off and retry.
      console.warn(`[discord-rest] network error attempt ${attempt}:`, err);
      if (attempt === MAX_RETRIES) throw err;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    // Success.
    if (res.ok) return;

    // Rate limited — honor retry_after (seconds, possibly fractional).
    if (res.status === 429) {
      let retryAfter = 1.0;
      try {
        const data = (await res.json()) as { retry_after?: number };
        if (typeof data.retry_after === "number") retryAfter = data.retry_after;
      } catch {
        // Malformed body — use default.
      }
      const waitMs = Math.ceil(retryAfter * 1000) + 200; // small buffer
      console.warn(`[discord-rest] 429, waiting ${waitMs}ms (attempt ${attempt})`);
      if (attempt === MAX_RETRIES) {
        throw new Error(`discord 429 after ${MAX_RETRIES} retries`);
      }
      await sleep(waitMs);
      continue;
    }

    // 5xx — back off and retry.
    if (res.status >= 500) {
      console.warn(`[discord-rest] ${res.status}, retrying (attempt ${attempt})`);
      if (attempt === MAX_RETRIES) {
        throw new Error(`discord ${res.status} after ${MAX_RETRIES} retries`);
      }
      await sleep(1000 * (attempt + 1));
      continue;
    }

    // Other 4xx — don't retry, surface the error. Likely a bad channel id,
    // missing permissions, or malformed payload.
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`discord ${res.status}: ${text.slice(0, 300)}`);
  }
}
