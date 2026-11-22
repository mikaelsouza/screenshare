import { isValidRoomCode, z } from "@shared/protocol";

/** Storage key for bounded localStorage persistence of room host tokens. */
export const HOST_ROOMS_STORAGE_KEY = "host-rooms";

/** Web Lock name serializing cross-tab read-modify-write updates to `host-rooms`. */
export const HOST_ROOMS_LOCK_NAME = "screenshare:host-rooms";

/** Maximum number of recently hosted rooms retained in localStorage. */
export const MAX_STORED_HOST_ROOMS = 20;

/** Local 90-day retention window counted from when this device last saved or refreshed a room's creator token. */
export const HOST_TOKEN_TTL_MS: number = 90 * 24 * 60 * 60 * 1000;

/** Maximum allowed forward clock skew on stored timestamps so future-dated entries expire reliably. */
export const MAX_CLOCK_SKEW_MS: number = 5 * 60 * 1000;

/** Minimal Storage subset needed for reading and writing persisted host tokens. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal iterable Storage subset used to purge legacy `host:<code>` sessionStorage entries. */
export interface SessionStorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** Minimal Web Locks API subset used to serialize cross-tab storage updates. */
export interface LockManagerLike {
  request(name: string, callback: () => Promise<void> | void): Promise<unknown>;
}

/** Summary of a valid persisted creator host room entry. */
export interface PersistedHostRoom {
  code: string;
  updatedAt: number;
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
    if (res.data.updatedAt > now + MAX_CLOCK_SKEW_MS) continue;
    const existing = byCode.get(code);
    if (!existing || res.data.updatedAt >= existing.updatedAt) {
      byCode.set(code, { code, token: res.data.token, updatedAt: res.data.updatedAt });
    }
  }
  return [...byCode.values()];
}

function persistEntries(storage: StorageLike, entries: HostRoomEntry[]): void {
  entries.sort((a, b) => a.updatedAt - b.updatedAt);
  const bounded = entries.slice(-MAX_STORED_HOST_ROOMS);

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
 * Return true if `storage` holds at least one valid, non-expired host token.
 */
export function hasAnyPersistedHostTokens(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  return loadHostRooms(storage, now).length > 0;
}

/**
 * List valid, non-expired persisted creator host rooms from `storage` without exposing tokens.
 */
export function listPersistedHostRooms(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): PersistedHostRoom[] {
  if (!storage) return [];
  return loadHostRooms(storage, now).map(({ code, updatedAt }) => ({ code, updatedAt }));
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
  persistEntries(storage, entries);
}

/**
 * Delete the persisted host token for `code` only if it matches `expectedToken` (preserving newer cross-tab tokens).
 */
export function removePersistedHostTokenIfMatching(
  storage: StorageLike | null | undefined,
  code: string,
  expectedToken: string | undefined,
  now: number = Date.now(),
): boolean {
  const upper = code.trim().toUpperCase();
  if (!storage || !expectedToken || !isValidRoomCode(upper)) return false;

  const entries = loadHostRooms(storage, now);
  const current = entries.find((entry) => entry.code === upper);
  if (!current || current.token !== expectedToken) return false;

  persistEntries(
    storage,
    entries.filter((entry) => entry.code !== upper),
  );
  return true;
}

/**
 * Remove all persisted host tokens from `storage`.
 */
export function clearAllPersistedHostTokens(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(HOST_ROOMS_STORAGE_KEY);
  } catch {
    /* ignore unavailable storage errors */
  }
}

/**
 * Remove all legacy `host:<code>` keys from `sessionStorage` while leaving unrelated session keys intact.
 */
export function clearLegacySessionHostTokens(storage: SessionStorageLike | null | undefined): void {
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith("host:")) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      storage.removeItem(k);
    }
  } catch {
    /* ignore unavailable storage */
  }
}

/**
 * Serialize a storage read-modify-write callback across tabs via the Web Locks API when available.
 */
export async function runWithHostRoomsLock(
  locks: LockManagerLike | null | undefined,
  fn: () => void,
): Promise<void> {
  if (!locks) {
    fn();
    return;
  }
  let ran = false;
  try {
    await locks.request(HOST_ROOMS_LOCK_NAME, () => {
      ran = true;
      fn();
    });
  } catch {
    if (!ran) fn();
  }
}
