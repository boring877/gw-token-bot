// /code — personal GachaWiki access codes, delivered as an ephemeral reply.
// The code is derived deterministically from the member's Discord id using the
// GW_SECRET shared with the gate worker (workers/gate in the gacha-wiki repo),
// so it is stable forever per account and identical to the web pickup path.
// The invite record is written to the shared MEMBERS KV namespace, bound to the
// first email that registers with it on the wiki.

import type { Env } from "./index";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Derive the personal wiki code for a Discord user id (mirrors the gate worker). */
export async function deriveWikiCode(secret: string, discordId: string): Promise<string> {
  const h = await hmacHex(secret, "discord:" + discordId);
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += CODE_ALPHABET[parseInt(h.slice(g * 4 + i, g * 4 + i + 1), 16) % CODE_ALPHABET.length];
    }
    groups.push(s);
  }
  return groups.join("-");
}

interface CodeInteraction {
  member?: { user?: { id?: string; username?: string }; roles?: string[] };
}

/** Handle the /code APPLICATION_COMMAND: role check, derive, store, ephemeral reply. */
export async function handleCodeInteraction(env: Env, interaction: CodeInteraction) {
  const EPHEMERAL = 64;
  const reply = (content: string) => ({ type: 4, data: { content, flags: EPHEMERAL } });

  const memberId = interaction.member?.user?.id;
  const username = interaction.member?.user?.username ?? "member";
  const roles = interaction.member?.roles ?? [];
  if (!memberId || !env.GW_SECRET || !env.WIKI_ROLE_ID || !env.MEMBERS) {
    return reply("The wiki code service is not configured yet. Tell the maintainer.");
  }
  if (!roles.includes(env.WIKI_ROLE_ID)) {
    return reply("You need the **Wiki Member** role first. Ask the maintainer for it.");
  }
  const code = await deriveWikiCode(env.GW_SECRET, memberId);
  const key = "invite:" + code;
  const existing = await env.MEMBERS.get(key);
  const rec = existing
    ? (JSON.parse(existing) as { email?: string | null })
    : { email: null as string | null };
  await env.MEMBERS.put(
    key,
    JSON.stringify({
      discord: memberId,
      discord_name: username,
      email: rec.email ?? null,
      created: Date.now(),
    }),
  );
  return reply(
    "**Your GachaWiki personal code: `" + code + "`**\n" +
      "It never changes and is linked to your Discord account. Use it with your email at https://gachawiki.info to sign up or to reset your password. Keep it private.\n" +
      "Only you can see this message.",
  );
}
