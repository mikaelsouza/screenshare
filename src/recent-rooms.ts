import { isValidRoomCode } from "@shared/protocol";
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
  insertEntryOrdered,
  isTimestampValid,
  mergeSynthesizedHostRooms,
  parseRecentRoomItem,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  sortAndBoundEntries,
  type RecentRoomEntry,
  type RecentRoomRole,
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

export interface RecentRoomUpsertInput {
  code: string;
  role: RecentRoomRole;
  lastJoinedAt?: number;
  peerNames?: readonly string[];
  password?: string;
  label?: string;
  clearLabel?: boolean;
  preserveOrder?: boolean;
  insertAfterCodes?: readonly string[];
}

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

function persistEntriesResult(
  storage: StorageLike,
  entries: RecentRoomEntry[],
): { entries: RecentRoomEntry[]; persisted: boolean } {
  const bounded = sortAndBoundEntries(entries);
  try {
    if (bounded.length === 0) {
      storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
    } else {
      storage.setItem(RECENT_ROOMS_STORAGE_KEY, JSON.stringify(bounded));
    }
    return { entries: bounded, persisted: true };
  } catch {
    return { entries: bounded, persisted: false };
  }
}

function persistEntries(storage: StorageLike, entries: RecentRoomEntry[]): RecentRoomEntry[] {
  return persistEntriesResult(storage, entries).entries;
}

/** Return true if `storage` is accessible and has no persisted `recent-rooms` key. */
export function isRecentRoomsKeyAbsent(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(RECENT_ROOMS_STORAGE_KEY);
    return raw === null || raw === "";
  } catch {
    return false;
  }
}

/** Return true if the user opted out of saving rooms on this device. */
export function isRecentRoomsDisabled(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    const val = storage.getItem(RECENT_ROOMS_OPT_OUT_KEY);
    return val === "1" || val === "true";
  } catch {
    return false;
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

/** Load, validate, prune expired/skewed, and sort recent room entries (newest first). */
export function loadRecentRooms(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): RecentRoomEntry[] {
  return tryLoadRecentRooms(storage, now).entries;
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
  entries: RecentRoomEntry[],
): boolean {
  if (!storage) return false;
  return persistEntriesResult(storage, entries).persisted;
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

function mergeUpsertEntry(
  code: string,
  input: RecentRoomUpsertInput,
  existing: RecentRoomEntry | undefined,
  lastJoinedAt: number,
): RecentRoomEntry {
  const password = sanitizePassword(input.password) ?? existing?.password;
  const label =
    input.label !== undefined
      ? sanitizeRecentRoomLabel(input.label)
      : input.clearLabel === true
        ? undefined
        : existing?.label;
  const incomingPeers = sanitizePeerNames(input.peerNames);
  const peerNames = incomingPeers.length > 0 ? incomingPeers : (existing?.peerNames ?? []);
  return {
    code,
    role: input.role,
    lastJoinedAt,
    peerNames,
    ...(password !== undefined ? { password } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/** Insert or update a recent room entry while retaining omitted password/label/peers from prior state. */
export function upsertRecentRoom(
  storage: StorageLike | null | undefined,
  input: RecentRoomUpsertInput,
  now: number = Date.now(),
): RecentRoomEntry[] {
  const code = input.code.trim().toUpperCase();
  if (!storage || !isValidRoomCode(code)) return loadRecentRooms(storage, now);

  const entries = loadRecentRooms(storage, now);
  const lastJoinedAt = input.lastJoinedAt ?? now;
  if (!isTimestampValid(lastJoinedAt, now)) return entries;

  const existing = entries.find((entry) => entry.code === code);
  const nextEntry = mergeUpsertEntry(code, input, existing, lastJoinedAt);
  if (input.preserveOrder === true && existing?.lastJoinedAt === lastJoinedAt) {
    return persistEntries(
      storage,
      entries.map((entry) => (entry.code === code ? nextEntry : entry)),
    );
  }
  const rest = entries.filter((entry) => entry.code !== code);
  return persistEntries(storage, insertEntryOrdered(rest, nextEntry, input.insertAfterCodes));
}

/** Update or clear the local custom nickname for an existing saved room entry. */
export function renameRecentRoom(
  storage: StorageLike | null | undefined,
  code: string,
  label: string,
  now: number = Date.now(),
): RecentRoomEntry[] {
  const upper = code.trim().toUpperCase();
  if (!storage || !isValidRoomCode(upper)) return loadRecentRooms(storage, now);

  const entries = loadRecentRooms(storage, now);
  const target = entries.find((entry) => entry.code === upper);
  if (!target) return entries;

  const nextLabel = sanitizeRecentRoomLabel(label);
  const updated: RecentRoomEntry = {
    code: target.code,
    role: target.role,
    lastJoinedAt: target.lastJoinedAt,
    peerNames: target.peerNames,
    ...(target.password !== undefined ? { password: target.password } : {}),
    ...(nextLabel !== undefined ? { label: nextLabel } : {}),
  };
  const next = entries.map((entry) => (entry.code === upper ? updated : entry));
  return persistEntries(storage, next);
}

/** Remove a single room entry from persisted `recent-rooms`, returning whether storage succeeded. */
export function removePersistedRecentRoom(
  storage: StorageLike | null | undefined,
  code: string,
  now: number = Date.now(),
): boolean {
  const upper = code.trim().toUpperCase();
  if (!storage || !isValidRoomCode(upper)) return false;
  const loaded = tryLoadRecentRooms(storage, now);
  if (!loaded.ok) return false;
  const next = loaded.entries.filter((entry) => entry.code !== upper);
  if (next.length === loaded.entries.length) return true;
  return writePersistedRecentRooms(storage, next);
}

/** Remove a single room entry from persisted `recent-rooms`. */
export function removeRecentRoom(
  storage: StorageLike | null | undefined,
  code: string,
  now: number = Date.now(),
): RecentRoomEntry[] {
  const upper = code.trim().toUpperCase();
  if (!storage || !isValidRoomCode(upper)) return loadRecentRooms(storage, now);

  const next = loadRecentRooms(storage, now).filter((entry) => entry.code !== upper);
  return persistEntries(storage, next);
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
