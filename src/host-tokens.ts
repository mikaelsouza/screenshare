import { isValidRoomCode, z } from "@shared/protocol";

/** Storage key for bounded localStorage persistence of room host tokens. */
export const HOST_ROOMS_STORAGE_KEY = "host-rooms";

/** Maximum number of recently hosted rooms retained in localStorage. */
export const MAX_STORED_HOST_ROOMS = 20;

/** Retention window matching the server-side 90-day room credential TTL. */
export const HOST_TOKEN_TTL_MS: number = 90 * 24 * 60 * 60 * 1000;

/** Minimal Storage subset needed for reading and writing persisted host tokens. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface HostRoomEntry {
  code: string;
  token: string;
  updatedAt: number;
}

const HostRoomEntrySchema: z.ZodType<HostRoomEntry> = z.object({
  code: z.string(),
  token: z.string().min(1).max(64),
  updatedAt: z.number().finite(),
});

function loadHostRooms(storage: StorageLike, now: number): HostRoomEntry[] {
  let raw: string | null;
  try {
    raw = storage.getItem(HOST_ROOMS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const byCode = new Map<string, HostRoomEntry>();
  for (const item of parsed) {
    const res = HostRoomEntrySchema.safeParse(item);
    if (!res.success) continue;
    const code = res.data.code.trim().toUpperCase();
    if (!isValidRoomCode(code)) continue;
    if (now - res.data.updatedAt >= HOST_TOKEN_TTL_MS) continue;
    const existing = byCode.get(code);
    if (!existing || res.data.updatedAt >= existing.updatedAt) {
      byCode.set(code, { code, token: res.data.token, updatedAt: res.data.updatedAt });
    }
  }
  return [...byCode.values()];
}

/**
 * Look up a non-expired host token for `code` in `storage`, returning undefined if missing or stale.
 */
export function readPersistedHostToken(
  storage: StorageLike | null | undefined,
  code: string,
  now: number = Date.now(),
): string | undefined {
  const upper = code.trim().toUpperCase();
  if (!storage || !isValidRoomCode(upper)) return undefined;
  return loadHostRooms(storage, now).find((entry) => entry.code === upper)?.token;
}

/**
 * Upsert or delete a room's host token in `storage`, pruning expired entries and bounding to the 20 most recent rooms.
 */
export function writePersistedHostToken(
  storage: StorageLike | null | undefined,
  code: string,
  token: string | undefined,
  now: number = Date.now(),
): void {
  const upper = code.trim().toUpperCase();
  if (!storage || !isValidRoomCode(upper)) return;

  const entries = loadHostRooms(storage, now).filter((entry) => entry.code !== upper);
  if (token !== undefined && token.length > 0 && token.length <= 64) {
    entries.push({ code: upper, token, updatedAt: now });
  }
  entries.sort((a, b) => a.updatedAt - b.updatedAt);
  const bounded =
    entries.length > MAX_STORED_HOST_ROOMS ? entries.slice(entries.length - MAX_STORED_HOST_ROOMS) : entries;

  try {
    if (bounded.length === 0) {
      storage.removeItem(HOST_ROOMS_STORAGE_KEY);
    } else {
      storage.setItem(HOST_ROOMS_STORAGE_KEY, JSON.stringify(bounded));
    }
  } catch {
    /* ignore unavailable storage or quota errors */
  }
}
