import type { LockManagerLike, StorageLike } from "./host-tokens";
import {
  MAX_CLOCK_SKEW_MS,
  MAX_RECENT_ROOM_LABEL_LEN,
  MAX_RECENT_ROOM_PASSWORD_LEN,
  MAX_RECENT_ROOM_PEERS,
  MAX_STORED_RECENT_ROOMS,
  RECENT_ROOM_TTL_MS,
  filterRecentRooms,
  formatRelativeTime,
  mergeSynthesizedHostRooms,
  parseRecentRoomItem,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  sortAndBoundEntries,
  type RecentRoomEntry,
} from "./recent-rooms-model";

export type { LockManagerLike, RecentRoomEntry, StorageLike };
export {
  MAX_CLOCK_SKEW_MS,
  MAX_RECENT_ROOM_LABEL_LEN,
  MAX_RECENT_ROOM_PASSWORD_LEN,
  MAX_RECENT_ROOM_PEERS,
  MAX_STORED_RECENT_ROOMS,
  RECENT_ROOM_TTL_MS,
  filterRecentRooms,
  formatRelativeTime,
  mergeSynthesizedHostRooms,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  sortAndBoundEntries,
};

/** Storage key for bounded localStorage persistence of recently joined rooms. */
export const RECENT_ROOMS_STORAGE_KEY = "recent-rooms";

/** Storage key for opt-out shared-device mode (`"1"` when room saving is disabled). */
export const RECENT_ROOMS_OPT_OUT_KEY = "recent-rooms-disabled";

/** Web Lock name serializing cross-tab read-modify-write updates to `recent-rooms`. */
export const RECENT_ROOMS_LOCK_NAME = "screenshare:recent-rooms";

function scanRawRecentRooms(raw: string, now: number): { entries: RecentRoomEntry[]; stale: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], stale: true };
  }
  if (!Array.isArray(parsed)) return { entries: [], stale: true };

  let stale = parsed.length === 0;
  const byCode = new Map<string, RecentRoomEntry>();
  for (const item of parsed) {
    const entry = parseRecentRoomItem(item, now);
    if (!entry) {
      stale = true;
      continue;
    }
    const existing = byCode.get(entry.code);
    if (existing) stale = true;
    if (!existing || entry.lastJoinedAt >= existing.lastJoinedAt) {
      byCode.set(entry.code, entry);
    }
  }
  const entries = sortAndBoundEntries([...byCode.values()]);
  if (entries.length < byCode.size) stale = true;
  return { entries, stale };
}

function scanRecentRooms(
  storage: StorageLike | null | undefined,
  now: number,
): { entries: RecentRoomEntry[]; stale: boolean } | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(RECENT_ROOMS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return { entries: [], stale: false };
  return scanRawRecentRooms(raw, now);
}

/** Read the opt-out flag (`recent-rooms-disabled`) from `storage`, returning `{ ok, disabled }` where `ok` is false if storage read failed. */
export function tryIsRecentRoomsDisabled(
  storage: StorageLike | null | undefined,
): { ok: boolean; disabled: boolean } {
  if (!storage) return { ok: false, disabled: false };
  try {
    const val = storage.getItem(RECENT_ROOMS_OPT_OUT_KEY);
    return { ok: true, disabled: val === "1" || val === "true" };
  } catch {
    return { ok: false, disabled: false };
  }
}

/** Persist or clear the shared-device opt-out flag (`recent-rooms-disabled`), returning whether storage succeeded. */
export function setRecentRoomsDisabled(
  storage: StorageLike | null | undefined,
  disabled: boolean,
): boolean {
  if (!storage) return false;
  try {
    if (disabled) {
      storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
    } else {
      storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/** Read and validate `recent-rooms` from `storage`, returning `{ entries, ok }` where `ok` is false if storage read failed. */
export function tryLoadRecentRooms(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): { entries: RecentRoomEntry[]; ok: boolean } {
  const scanned = scanRecentRooms(storage, now);
  if (!scanned) return { entries: [], ok: false };
  return { entries: scanned.entries, ok: true };
}

/** Return true if `storage` contains expired, invalid, duplicate, or unbounded `recent-rooms` records needing pruning. */
export function hasStaleRecentRooms(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): boolean {
  return scanRecentRooms(storage, now)?.stale ?? false;
}

/** Write sorted, bounded `entries` to `storage`, returning whether the storage write succeeded. */
export function writePersistedRecentRooms(
  storage: StorageLike | null | undefined,
  entries: readonly RecentRoomEntry[],
): boolean {
  if (!storage) return false;
  const bounded = sortAndBoundEntries(entries);
  try {
    if (bounded.length === 0) {
      storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
    } else {
      storage.setItem(RECENT_ROOMS_STORAGE_KEY, JSON.stringify(bounded));
    }
    return true;
  } catch {
    return false;
  }
}

/** Prune expired, invalid, or duplicate records from `recent-rooms` in `storage` if any exist. */
export function pruneExpiredRecentRooms(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): boolean {
  const scanned = scanRecentRooms(storage, now);
  if (!scanned || !scanned.stale) return false;
  return writePersistedRecentRooms(storage, scanned.entries);
}

/** Remove all persisted entries from `recent-rooms` in `storage`, returning whether storage succeeded. */
export function clearAllPersistedRecentRooms(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Serialize a storage read-modify-write callback across tabs via the Web Locks API when available. */
export async function runWithRecentRoomsLock(
  locks: LockManagerLike | null | undefined,
  fn: () => void,
): Promise<void> {
  if (!locks) {
    fn();
    return;
  }
  let ran = false;
  try {
    await locks.request(RECENT_ROOMS_LOCK_NAME, () => {
      ran = true;
      fn();
    });
  } catch {
    if (!ran) fn();
  }
}
