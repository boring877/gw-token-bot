// NFT holder verification — the OG Holder role gate. Flow:
//   1. A member runs /verify in Discord -> the bot issues a one-time code
//      (stored in the DO, 15 min TTL) and links them to the wiki verify page.
//   2. On gachawiki.net/verify the holder connects their wallet and signs
//      "GachaWiki OG verification: <code>" (EIP-191 personal_sign).
//   3. The wiki POSTs {code, address, signature} to /verifylink here.
//   4. We recover the signer from the signature (must equal `address`),
//      check balanceOf(address) >= 1 on the OG contract, then assign the
//      OG Holder role and store the wallet<->member link for auto-revoke.
// Auto-revoke lives in gateway.ts: when a linked wallet MOVES an OG away and
// its balance hits 0, the role is removed.

import { recoverMessageAddress } from "viem";
import { VERIFY_MESSAGE_PREFIX, VERIFY_CODE_TTL_MS, WIKI_VERIFY_URL } from "./config";
import { ogBalanceOf } from "./nftfeed";

/** Unambiguous alphabet for one-time codes (no 0/O/1/I). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Generate a 6-char one-time code from crypto randomness. */
export function generateCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** True if `code` looks like one of ours (shape only — validity is DO-side). */
export function isPlausibleCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z2-9]{6}$/.test(code);
}

/** True if `address` is a well-formed EVM address (0x + 40 hex). */
export function isPlausibleAddress(address: unknown): address is string {
  return (
    typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)
  );
}

/** True if `signature` is a well-formed 65-byte hex signature. */
export function isPlausibleSignature(signature: unknown): signature is string {
  return (
    typeof signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(signature)
  );
}

/** A pending verification code, stored in the DO. */
export interface VerifyCodeEntry {
  memberId: string;
  guildId: string;
  /** Epoch ms after which the code is stale. */
  expires: number;
}

/** A verified wallet<->member link, stored in the DO. */
export interface WalletLink {
  memberId: string;
  guildId: string;
  /** Epoch ms when the link was created. */
  linkedAt: number;
}

/** Storage key for a pending code. */
export function codeKey(code: string): string {
  return `verify:code:${code.toUpperCase()}`;
}

/** Storage key for a linked wallet (address is stored lowercase). */
export function walletKey(address: string): string {
  return `verify:wallet:${address.toLowerCase()}`;
}

/** Reverse-lookup key: member id -> linked address. */
export function memberKey(memberId: string): string {
  return `verify:member:${memberId}`;
}

/**
 * The signed message for a code — MUST match what the wiki's verify page
 * asks the wallet to sign (EIP-191 personal_sign).
 */
export function messageForCode(code: string): string {
  return `${VERIFY_MESSAGE_PREFIX}${code.toUpperCase()}`;
}

/** Discord API helper with auth — JSON in, JSON/status out. */
async function discordFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

/** Assign the OG Holder role to a member. Throws on Discord error. */
export async function assignOgRole(
  token: string,
  guildId: string,
  roleId: string,
  memberId: string,
): Promise<void> {
  const res = await discordFetch(
    token,
    "PUT",
    `/guilds/${guildId}/members/${memberId}/roles/${roleId}`,
  );
  if (!res.ok) {
    throw new Error(`role assign ${res.status}: ${await res.text()}`);
  }
}

/** Remove the OG Holder role from a member. Throws on Discord error. */
export async function removeOgRole(
  token: string,
  guildId: string,
  roleId: string,
  memberId: string,
): Promise<void> {
  const res = await discordFetch(
    token,
    "DELETE",
    `/guilds/${guildId}/members/${memberId}/roles/${roleId}`,
  );
  if (!res.ok) {
    throw new Error(`role remove ${res.status}: ${await res.text()}`);
  }
}

/** What the DO stores/retrieves for the verify flow (implemented in gateway). */
export interface VerifyStore {
  putCode(code: string, entry: VerifyCodeEntry): Promise<void>;
  getCode(code: string): Promise<VerifyCodeEntry | null>;
  deleteCode(code: string): Promise<void>;
  putWalletLink(address: string, link: WalletLink): Promise<void>;
  getWalletLink(address: string): Promise<WalletLink | null>;
  getWalletByMember(memberId: string): Promise<string | null>;
  deleteWalletLink(address: string): Promise<void>;
}

/**
 * Handle an incoming APPLICATION_COMMAND interaction for /verify and /check.
 * `store` is the DO-backed implementation.
 */
export async function handleVerifyInteraction(
  env: { DISCORD_TOKEN: string; GUILD_ID: string; OG_ROLE_ID: string },
  store: VerifyStore,
  interaction: {
    type: number;
    guild_id?: string;
    data?: { name?: string };
    member?: { user?: { id?: string; username?: string } };
    user?: { id?: string; username?: string };
  },
): Promise<{ type: number; data?: { content: string; flags: number } }> {
  const EPHEMERAL = 64;
  const name = interaction.data?.name ?? "";

  // PING from Discord (endpoint validation / health check) -> PONG.
  if (interaction.type === 1) {
    return { type: 1 };
  }

  if (interaction.type !== 2) {
    return { type: 4, data: { content: "?", flags: EPHEMERAL } };
  }

  // Only meaningful inside the configured guild.
  if (interaction.guild_id !== env.GUILD_ID) {
    return {
      type: 4,
      data: { content: "Run this in the GachaWiki server.", flags: EPHEMERAL },
    };
  }

  const memberId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!memberId) {
    return { type: 4, data: { content: "Couldn't read your user id.", flags: EPHEMERAL } };
  }

  if (name === "verify") {
    const code = generateCode();
    await store.putCode(code, {
      memberId,
      guildId: interaction.guild_id,
      expires: Date.now() + VERIFY_CODE_TTL_MS,
    });
    const url = `${WIKI_VERIFY_URL}?code=${code}`;
    return {
      type: 4,
      data: {
        flags: EPHEMERAL,
        content:
          `🔐 **Verify your GachaWiki OG**\n` +
          `Your one-time code: \`${code}\` (valid 15 minutes)\n` +
          `1. Open <${url}>\n` +
          `2. Connect the wallet that holds your OG and press **Sign & Verify**\n` +
          `You'll get the <@&${env.OG_ROLE_ID}> role instantly.`,
      },
    };
  }

  if (name === "check") {
    const address = await store.getWalletByMember(memberId);
    if (!address) {
      return {
        type: 4,
        data: {
          content: "No wallet linked yet — run `/verify` first.",
          flags: EPHEMERAL,
        },
      };
    }
    const balance = await ogBalanceOf(address);
    const n = balance == null ? "?" : balance.toString();
    return {
      type: 4,
      data: {
        content: `Linked wallet: \`${address}\`\nOG balance: **${n}**`,
        flags: EPHEMERAL,
      },
    };
  }

  return { type: 4, data: { content: "Unknown command.", flags: EPHEMERAL } };
}

/** JSON response shape of /verifylink. */
interface VerifyLinkOutcome {
  ok: boolean;
  error?: string;
  balance?: string;
}

/**
 * Handle the wiki's POST /verifylink: validate the code, recover the signer,
 * require >= 1 OG, assign the role, persist the link. Returns a JSON-able
 * outcome (never throws — errors become {ok:false,error}).
 */
export async function handleVerifyLink(
  env: {
    DISCORD_TOKEN: string;
    GUILD_ID: string;
    OG_ROLE_ID: string;
    getStub(): { fetch(url: string, init?: RequestInit): Promise<Response> };
  },
  body: { code?: unknown; address?: unknown; signature?: unknown },
): Promise<{ status: number; json: VerifyLinkOutcome }> {
  if (
    !isPlausibleCode(body.code) ||
    !isPlausibleAddress(body.address) ||
    !isPlausibleSignature(body.signature)
  ) {
    return { status: 400, json: { ok: false, error: "bad_request" } };
  }
  const code = body.code;
  const address = body.address;

  const store = doStore(env.getStub());
  const entry = await store.getCode(code);
  if (!entry || entry.expires < Date.now()) {
    return { status: 400, json: { ok: false, error: "invalid_code" } };
  }
  // Single-use: burn the code immediately after reading it.
  await store.deleteCode(code);

  // Proof of ownership: the signature must recover to the given address.
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: messageForCode(code),
      signature: body.signature as `0x${string}`,
    });
  } catch {
    return { status: 400, json: { ok: false, error: "bad_signature" } };
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { status: 400, json: { ok: false, error: "signature_mismatch" } };
  }

  // Holdings check: >= 1 OG.
  const balance = await ogBalanceOf(address);
  if (balance == null) {
    return { status: 502, json: { ok: false, error: "rpc_unavailable" } };
  }
  if (balance < 1n) {
    return {
      status: 403,
      json: { ok: false, error: "no_og", balance: balance.toString() },
    };
  }

  // Grant the role + persist the link (both idempotent-ish: role PUT is a
  // no-op if held; link overwrite is intentional for re-verifies).
  try {
    await assignOgRole(env.DISCORD_TOKEN, entry.guildId, env.OG_ROLE_ID, entry.memberId);
  } catch (err) {
    console.error("[verify] role assign failed:", err);
    return { status: 502, json: { ok: false, error: "role_failed" } };
  }
  await store.putWalletLink(address, {
    memberId: entry.memberId,
    guildId: entry.guildId,
    linkedAt: Date.now(),
  });

  console.log(`[verify] linked ${address} -> member ${entry.memberId}`);
  return { status: 200, json: { ok: true, balance: balance.toString() } };
}

/**
 * The DO-backed VerifyStore — talks to the GatewayDO over stub.fetch with
 * internal /do/ routes (see gateway.ts fetch()).
 */
export function doStore(
  stub: { fetch(url: string, init?: RequestInit): Promise<Response> },
): VerifyStore {
  const BASE = "https://do";
  const send = (path: string, init?: RequestInit): Promise<Response> =>
    stub.fetch(`${BASE}${path}`, init);
  const json = async <T>(path: string, init?: RequestInit): Promise<T | null> => {
    const res = await send(path, init);
    return res.status === 204 ? null : ((await res.json()) as T);
  };
  const put = (path: string, payload: unknown): Promise<void> =>
    send(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(() => undefined);
  const del = (path: string): Promise<void> =>
    send(path, { method: "DELETE" }).then(() => undefined);

  return {
    putCode: (code, entry) =>
      put("/do/code", { code, ...entry }),
    getCode: (code) => json<VerifyCodeEntry>(`/do/code?code=${encodeURIComponent(code)}`),
    deleteCode: (code) => del(`/do/code?code=${encodeURIComponent(code)}`),
    putWalletLink: (address, link) =>
      put("/do/wallet", { address, ...link }),
    getWalletLink: (address) =>
      json<WalletLink>(`/do/wallet?address=${encodeURIComponent(address)}`),
    getWalletByMember: (memberId) =>
      json<{ address: string }>(`/do/wallet?memberId=${encodeURIComponent(memberId)}`).then(
        (v) => v?.address ?? null,
      ),
    deleteWalletLink: (address) =>
      del(`/do/wallet?address=${encodeURIComponent(address)}`),
  };
}
