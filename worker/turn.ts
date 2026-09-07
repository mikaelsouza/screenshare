import { dropPort53, hasTurnServer, hasUrls } from "@shared/ice";
import type { IceServerConfig } from "@shared/protocol";

export interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}

const CF_STUN_SERVER: IceServerConfig = {
  urls: "stun:stun.cloudflare.com:3478",
};

export const TURN_TTL_SECONDS = 2 * 60 * 60;

/** Re-mint a little before expiry so nobody is handed a credential about to die. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How long a failed mint is remembered. Short enough that a blip is not an outage. */
export const FAILED_MINT_CACHE_MS = 30 * 1000;

interface CachedIce {
  iceServers: IceServerConfig[];
  expiresAt: number;
}

/**
 * Mint through a per-caller cache. Every join would otherwise hit the Cloudflare API,
 * and credentials are identical for everyone in the room anyway.
 */
export async function getIceServers(
  env: TurnEnv,
  cache: { current: CachedIce | null },
): Promise<IceServerConfig[]> {
  const now = Date.now();
  if (cache.current && cache.current.expiresAt > now) return cache.current.iceServers;

  const { iceServers } = await mintIceServers(env);

  // A mint that failed falls back to STUN only. Caching that for the credential TTL
  // would leave the room without any relay for nearly two hours on the strength of one
  // transient API error: every pair behind a symmetric NAT silently fails to connect,
  // and relay-only mode is unavailable to everyone for the rest of the window. Retry
  // it in seconds instead.
  const succeeded = hasTurnServer(iceServers);
  cache.current = {
    iceServers,
    expiresAt: succeeded
      ? now + TURN_TTL_SECONDS * 1000 - REFRESH_MARGIN_MS
      : now + FAILED_MINT_CACHE_MS,
  };
  return iceServers;
}

/**
 * Cloudflare Realtime TURN credentials generation endpoint path.
 * Re-check against Cloudflare's Realtime TURN documentation if endpoint schema changes:
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */
const CF_TURN_CREDENTIALS_ENDPOINT = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;

export async function mintIceServers(env: TurnEnv): Promise<{ iceServers: IceServerConfig[] }> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    console.warn("TURN_KEY_ID or TURN_API_TOKEN is not configured; using STUN only");
    return { iceServers: [CF_STUN_SERVER] };
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
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    });

    if (!res.ok) {
      console.warn(
        `Cloudflare TURN API returned error: ${res.status} ${res.statusText}; using STUN only`,
      );
      return { iceServers: [CF_STUN_SERVER] };
    }

    const data = (await res.json()) as { iceServers?: IceServerConfig[] };
    const remoteServers = Array.isArray(data.iceServers) ? data.iceServers : [];
    return { iceServers: [CF_STUN_SERVER, ...remoteServers].map(dropPort53).filter(hasUrls) };
  } catch (err) {
    console.warn("Failed to contact Cloudflare TURN API; using STUN only:", err);
    return { iceServers: [CF_STUN_SERVER] };
  }
}
