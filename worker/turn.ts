import { dropPort53, hasTurnServer, hasUrls } from "@shared/ice";
import type { IceServerConfig } from "@shared/protocol";

export interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  /**
   * Kill switch. Set to "true" (as a secret, so a deploy does not reset it:
   * `npx wrangler secret put TURN_DISABLED`) and every join gets STUN only. Direct
   * connections keep working; Hide my IP refuses to connect, as it must.
   */
  TURN_DISABLED?: string;
}

const CF_STUN_SERVER: IceServerConfig = {
  urls: "stun:stun.cloudflare.com:3478",
};

export const TURN_TTL_SECONDS = 2 * 60 * 60;

/** TTL for the credentials the diagnostics page gets: enough to allocate one relay. */
export const DIAGNOSTICS_TURN_TTL_SECONDS = 5 * 60;

/** How long a failed mint is remembered. Short enough that a blip is not an outage. */
export const FAILED_MINT_CACHE_MS = 30 * 1000;

/** What one join is handed: the servers, and the TURN username to revoke on leave. */
export interface MintedIce {
  iceServers: IceServerConfig[];
  /** Null when no TURN credential was issued (STUN only). */
  username: string | null;
}

/**
 * Mint credentials for one peer.
 *
 * Every join gets its own credential rather than one shared by the whole room. A
 * shared one could not be taken back from a single person: someone who left, or was
 * kicked, kept relay access on our Cloudflare allocation until it expired. Per-peer,
 * the room revokes each credential as its holder leaves (revokeCredential).
 *
 * `backoff` remembers a failed mint for FAILED_MINT_CACHE_MS, so a Cloudflare outage
 * costs one API call per 30 seconds per room rather than one per join.
 */
export async function getIceServers(
  env: TurnEnv,
  backoff: { failedUntil: number },
  ttlSeconds: number = TURN_TTL_SECONDS,
): Promise<MintedIce> {
  const now = Date.now();
  if (now < backoff.failedUntil) return { iceServers: [CF_STUN_SERVER], username: null };

  const minted = await mintIceServers(env, ttlSeconds);
  // Only a real failure backs off. With TURN switched off or unconfigured there is
  // no API call to save.
  if (turnConfigured(env) && !hasTurnServer(minted.iceServers)) {
    backoff.failedUntil = now + FAILED_MINT_CACHE_MS;
  }
  return minted;
}

function turnConfigured(env: TurnEnv): boolean {
  return Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN) && env.TURN_DISABLED !== "true";
}

/**
 * Cloudflare Realtime TURN credentials generation endpoint path.
 * Re-check against Cloudflare's Realtime TURN documentation if endpoint schema changes:
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */
const CF_TURN_CREDENTIALS_ENDPOINT = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;

export async function mintIceServers(
  env: TurnEnv,
  ttlSeconds: number = TURN_TTL_SECONDS,
): Promise<MintedIce> {
  if (env.TURN_DISABLED === "true") {
    return { iceServers: [CF_STUN_SERVER], username: null };
  }
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    console.warn("TURN_KEY_ID or TURN_API_TOKEN is not configured; using STUN only");
    return { iceServers: [CF_STUN_SERVER], username: null };
  }

  const endpoint = CF_TURN_CREDENTIALS_ENDPOINT(env.TURN_KEY_ID);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      // Two hours, not the 24 that used to be minted here. These credentials let the
      // bearer relay traffic through our Cloudflare allocation on our bandwidth, so
      // the blast radius of a leaked set should be a session, not a day.
      body: JSON.stringify({ ttl: ttlSeconds }),
    });

    if (!res.ok) {
      console.warn(
        `Cloudflare TURN API returned error: ${res.status} ${res.statusText}; using STUN only`,
      );
      return { iceServers: [CF_STUN_SERVER], username: null };
    }

    const data = (await res.json()) as { iceServers?: IceServerConfig[] };
    const remoteServers = Array.isArray(data.iceServers) ? data.iceServers : [];
    const username = remoteServers.find((s) => typeof s.username === "string")?.username ?? null;
    return {
      iceServers: [CF_STUN_SERVER, ...remoteServers].map(dropPort53).filter(hasUrls),
      username,
    };
  } catch (err) {
    console.warn("Failed to contact Cloudflare TURN API; using STUN only:", err);
    return { iceServers: [CF_STUN_SERVER], username: null };
  }
}

/**
 * Revoke one peer's TURN credential, so it stops working the moment its holder
 * leaves rather than when it expires. Best effort: a failure is logged and the
 * credential simply lives out its TTL, as every credential did before.
 *
 * Cloudflare documents 204 on success. It does not say whether revoking also tears
 * down a relay allocation already in use, so treat this as closing the door to new
 * allocations, not as cutting a live relay.
 */
export async function revokeCredential(env: TurnEnv, username: string): Promise<boolean> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return false;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/${encodeURIComponent(username)}/revoke`,
      { method: "POST", headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}` } },
    );
    if (!res.ok) console.warn(`Cloudflare TURN revoke returned ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn("Failed to revoke TURN credential:", err);
    return false;
  }
}
