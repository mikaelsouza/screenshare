/**
 * The key a client address is rate-limited under.
 *
 * IPv4 addresses are used as they are. An IPv6 client normally holds a whole /64 and
 * can pick any address inside it, so keying on the full address gives one person 2^64
 * separate budgets; the /64 prefix is the unit that actually identifies a subscriber.
 * IPv4-mapped IPv6 (::ffff:1.2.3.4) is the IPv4 address in disguise, keyed as such.
 */
export function ipKey(ip: string): string {
  const addr = ip.trim().toLowerCase();
  if (!addr.includes(":")) return addr;

  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1]) return mapped[1];

  const hextets = expandIpv6(addr);
  if (!hextets) return addr;
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/** Eight hextets without leading zeros, or null if this is not an IPv6 address. */
function expandIpv6(addr: string): string[] | null {
  const noZone = addr.split("%")[0] ?? "";
  const halves = noZone.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => h.replace(/^0+(?=.)/, ""));
}
