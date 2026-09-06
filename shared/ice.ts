import type { IceServerConfig } from "./protocol";

/**
 * Matches an ICE URL whose port is exactly 53.
 *
 * The `(?:\?|$)` is load-bearing: a bare ":53" substring also matches ":5349", and
 * silently discarding turns:5349 would remove a TLS fallback we depend on.
 */
export const PORT_53 = /:53(?:\?|$)/;

/**
 * Strip every endpoint on port 53 from an ICE server entry.
 *
 * Cloudflare hands out stun/turn on port 53 to help clients on networks that only
 * permit DNS traffic. But UDP/53 is very commonly intercepted by ISPs and routers
 * doing DNS redirection, and a STUN/TURN endpoint that black-holes has an outsized
 * effect: measured against a live deployment, including Cloudflare's :53 entries
 * produced srflx=0 — Chrome yielded NO server-reflexive candidate at all, rather
 * than skipping the dead endpoint — which forced every connection onto a TURN
 * relay and defeated the point of the whole design. Dropping :53 restored srflx.
 *
 * The cost is one fallback path for DNS-only networks; turn:80/tcp and turns:443
 * still cover restrictive firewalls, so the trade strongly favours dropping it.
 */
export function dropPort53(server: IceServerConfig): IceServerConfig {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
    (u) => !PORT_53.test(u),
  );
  return { ...server, urls };
}

export function hasUrls(server: IceServerConfig): boolean {
  return Array.isArray(server.urls) ? server.urls.length > 0 : Boolean(server.urls);
}
