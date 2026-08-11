// Builds Discord gateway PRESENCE UPDATE payloads from $GW stats. Each stat
// slot has its own emoji + activity type so the six slots look visually
// distinct in the member list. The bot's status dot also reflects 24h
// direction (green up / red down / yellow flat). Mirrors the stat order from
// TokenBanner.astro's cycling chip: price -> 24h -> 1h -> MC -> vol -> liq.

import { OP } from "./config";
import { fmtPct, fmtPrice, fmtUsd, type Stats } from "./dexscreener";

/** Discord activity types. See https://discord.com/developers/docs/topics/gateway-events */
// 0 = Playing (default gray), 1 = Streaming (needs URL, unused),
// 2 = Listening (amber/purple), 3 = Watching (red-ish), 5 = Competing (pink).
const ACTIVITY_PLAYING = 0;
const ACTIVITY_LISTENING = 2;
const ACTIVITY_WATCHING = 3;
const ACTIVITY_COMPETING = 5;

/** Discord presence status values — controls the dot color next to the name. */
export type PresenceStatus = "online" | "idle" | "dnd";

/** One renderable slot in the cycle. */
interface StatSlot {
  /** Full activity text shown after the verb (e.g. "$GW 💰 $0.001234"). */
  text: string;
  /** Discord activity type — changes the verb + icon. */
  type: number;
}

/**
 * Build the six stat slots in cycle order. Order matches TokenBanner.astro's
 * buildStats(): price, change24h, change1h, mc, volume24h, liquidity.
 * Each slot pairs an emoji with a distinct activity type for visual variety.
 */
export function buildStatSlots(stats: Stats): StatSlot[] {
  const slots: StatSlot[] = [];
  if (stats.price != null) {
    slots.push({
      text: `$GW 💰 ${fmtPrice(stats.price)}`,
      type: ACTIVITY_WATCHING,
    });
  }
  const c24 = fmtPct(stats.change24h);
  if (c24) {
    slots.push({
      text: `$GW 📈 24h ${c24}`,
      type: ACTIVITY_LISTENING,
    });
  }
  const c1 = fmtPct(stats.change1h);
  if (c1) {
    slots.push({
      text: `$GW 📉 1h ${c1}`,
      type: ACTIVITY_COMPETING,
    });
  }
  const mc = fmtUsd(stats.mc);
  if (mc) {
    slots.push({
      text: `$GW 🏦 MC ${mc}`,
      type: ACTIVITY_WATCHING,
    });
  }
  const vol = fmtUsd(stats.volume24h);
  if (vol) {
    slots.push({
      text: `$GW 📊 Vol ${vol}`,
      type: ACTIVITY_LISTENING,
    });
  }
  const liq = fmtUsd(stats.liquidity);
  if (liq) {
    slots.push({
      text: `$GW 💧 Liq ${liq}`,
      type: ACTIVITY_PLAYING,
    });
  }
  return slots;
}

/**
 * Decide the bot's status dot from the 24h price direction. Green when up,
 * red when down, yellow when flat or unknown. Drives the dot color in the
 * member list — a glanceable mood signal on top of the activity text.
 */
export function statusFor24h(stats: Stats): PresenceStatus {
  const c = stats.change24h;
  if (c == null || !isFinite(c)) return "idle"; // yellow — unknown
  if (c > 0.5) return "online"; // green — clearly up
  if (c < -0.5) return "dnd"; // red — clearly down
  return "idle"; // yellow — flat (within +/-0.5%)
}

/**
 * Build an OP 3 PRESENCE UPDATE payload. The activity text + type come from
 * the chosen slot; the status dot reflects 24h direction.
 */
export function buildPresencePayload(
  slot: StatSlot,
  status: PresenceStatus,
): string {
  // Activity name shows the full text; Discord prefixes it with the verb that
  // matches the type (Watching/Listening to/Competing in/Playing).
  const activity = {
    name: slot.text,
    type: slot.type,
  };

  return JSON.stringify({
    op: OP.PRESENCE_UPDATE,
    d: {
      since: null,
      activities: [activity],
      status,
      afk: false,
    },
  });
}

/** Result of computing one presence tick: the payload string + the status shown. */
export interface PresenceUpdate {
  payload: string;
  status: PresenceStatus;
}

/** Build a presence update from a bare stat index, cycling through slots. */
export function presenceForIndex(stats: Stats, index: number): PresenceUpdate | null {
  const slots = buildStatSlots(stats);
  if (slots.length === 0) return null;
  const slot = slots[index % slots.length];
  const status = statusFor24h(stats);
  return { payload: buildPresencePayload(slot, status), status };
}
