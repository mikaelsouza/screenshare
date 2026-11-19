import { generateRoomPassword } from "@shared/protocol";
import type { PreMintedEmptyReset, PreMintedRotation } from "./room-models";

const TEXT_ENCODER = new TextEncoder();

export type RoomSecretKind = "host" | "rejoin" | "password";

/**
 * Constant-time string comparison over UTF-8 encoded buffers.
 *
 * Uses Cloudflare Workers' native `crypto.subtle.timingSafeEqual` when available
 * and falls back to a fixed-time XOR scan in Node/standard WebCrypto runtimes.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = TEXT_ENCODER.encode(a);
  const bb = TEXT_ENCODER.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  const nativeTimingSafeEqual: unknown = Reflect.get(crypto.subtle, "timingSafeEqual");
  if (typeof nativeTimingSafeEqual === "function") {
    return Boolean(Reflect.apply(nativeTimingSafeEqual, crypto.subtle, [ab, bb]));
  }
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Compute a domain-separated, room-salted SHA-256 hex digest for a room secret.
 * Must always be called BEFORE entering `blockConcurrencyWhile` / DO storage I/O.
 */
export async function hashRoomSecret(
  roomId: string,
  secret: string,
  kind: RoomSecretKind,
): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(`${roomId}:${kind}:${secret}`));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pre-mint a fresh invite secret and its hash outside any DO storage transaction. */
export async function preMintEmptyResetSecret(roomId: string): Promise<PreMintedEmptyReset> {
  const password = generateRoomPassword();
  const passwordHash = await hashRoomSecret(roomId, password, "password");
  return { password, passwordHash };
}

/**
 * Pre-mint a rotated room password and `ticketCount` fresh rejoin tickets outside
 * any DO storage transaction so input-gate atomicity is preserved.
 */
export async function preMintRotationCredentials(
  roomId: string,
  ticketCount: number,
): Promise<PreMintedRotation> {
  const newPassword = generateRoomPassword();
  const newPasswordHash = await hashRoomSecret(roomId, newPassword, "password");
  const tickets = await Promise.all(
    Array.from({ length: Math.max(0, ticketCount) }, async () => {
      const token = crypto.randomUUID();
      const hash = await hashRoomSecret(roomId, token, "rejoin");
      return { token, hash };
    }),
  );
  return { newPassword, newPasswordHash, tickets };
}
