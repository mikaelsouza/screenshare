import type { Env } from "./index";

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const CF_STUN_SERVER: RTCIceServerLike = {
  urls: "stun:stun.cloudflare.com:3478",
};

/**
 * Cloudflare Realtime TURN credentials generation endpoint path.
 * Re-check against Cloudflare's Realtime TURN documentation if endpoint schema changes:
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */
const CF_TURN_CREDENTIALS_ENDPOINT = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;

export async function mintIceServers(env: Env): Promise<{ iceServers: RTCIceServerLike[] }> {
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
      body: JSON.stringify({ ttl: 86400 }),
    });

    if (!res.ok) {
      console.warn(
        `Cloudflare TURN API returned error: ${res.status} ${res.statusText}; using STUN only`,
      );
      return { iceServers: [CF_STUN_SERVER] };
    }

    const data = (await res.json()) as { iceServers?: RTCIceServerLike[] };
    const remoteServers = Array.isArray(data.iceServers) ? data.iceServers : [];
    return { iceServers: [CF_STUN_SERVER, ...remoteServers] };
  } catch (err) {
    console.warn("Failed to contact Cloudflare TURN API; using STUN only:", err);
    return { iceServers: [CF_STUN_SERVER] };
  }
}
