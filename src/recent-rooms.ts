import { isValidRoomCode, z } from "@shared/protocol";
import type { LockManagerLike, PersistedHostRoom, StorageLike } from "./host-tokens";

export type { LockManagerLike, StorageLike };

/** Storage key for bounded localStorage persistence of recently joined rooms. */
export const RECENT_ROOMS_STORAGE_KEY = "recent-rooms";

/** Storage key for opt-out shared-device mode (`"1"` when room saving is disabled). */
export const RECENT_ROOMS_OPT_OUT_KEY = "recent-rooms-disabled";

/** Web Lock name serializing cross-tab read-modify-write updates to `recent-rooms`. */
export const RECENT_ROOMS_LOCK_NAME = "screenshare:recent-rooms";

/** Maximum number of recently visited rooms retained in localStorage. */
export const MAX_STORED_RECENT_ROOMS = 20;

/** Local 90-day retention window matching RoomDO's reusable credentials cap. */
export const RECENT_ROOM_TTL_MS: number = 90 * 24 * 60 * 60 * 1000;

/** Maximum allowed forward clock skew on stored timestamps so future-dated entries expire reliably. */
export const MAX_CLOCK_SKEW_MS: number = 5 * 60 * 1000;

/** Maximum UTF-16 code units allowed for a local custom room nickname. */
export const MAX_RECENT_ROOM_LABEL_LEN = 40;

/** Maximum number of last-seen peer names retained per recent room entry. */
export const MAX_RECENT_ROOM_PEERS = 4;

/** Maximum invite secret length accepted, matching `MAX_PASSWORD_WIRE_LENGTH` in `shared/protocol.ts`. */
export const MAX_RECENT_ROOM_PASSWORD_LEN = 128;

const MAX_PEER_NAME_LEN = 32;

export type RecentRoomRole = "host" | "guest";

export interface RecentRoomEntry {
  code: string;
  role: RecentRoomRole;
  lastJoinedAt: number;
  peerNames: string[];
  password?: string;
  label?: string;
}

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

const RecentRoomRawSchema = z.object({
  code: z.string(),
  role: z.enum(["host", "guest"]),
  lastJoinedAt: z.number().finite(),
  peerNames: z.array(z.string()).optional(),
  password: z.string().trim().max(MAX_RECENT_ROOM_PASSWORD_LEN).optional(),
  label: z.string().optional(),
});

function trimCodeUnits(raw: string, maxLen: number): string {
  if (raw.length <= maxLen) return raw;
  let end = maxLen;
  const unit = raw.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) {
    end -= 1;
  }
  return raw.slice(0, end).trimEnd();
}

/** Trim and clamp a local room nickname to `MAX_RECENT_ROOM_LABEL_LEN`, returning undefined if blank. */
export function sanitizeRecentRoomLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = trimCodeUnits(raw.trim(), MAX_RECENT_ROOM_LABEL_LEN);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Trim, filter empty entries, and cap peer names to `MAX_RECENT_ROOM_PEERS`. */
export function sanitizePeerNames(names: readonly string[] | undefined): string[] {
  if (!names) return [];
  const out: string[] = [];
  for (const name of names) {
    const clean = trimCodeUnits(name.trim(), MAX_PEER_NAME_LEN);
    if (clean.length === 0) continue;
    out.push(clean);
    if (out.length >= MAX_RECENT_ROOM_PEERS) break;
  }
  return out;
}

/** Trim and validate an invite secret against `MAX_RECENT_ROOM_PASSWORD_LEN`, returning undefined if empty or too long. */
export function sanitizePassword(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const clean = raw.trim();
  return clean.length > 0 && clean.length <= MAX_RECENT_ROOM_PASSWORD_LEN ? clean : undefined;
}

function isTimestampValid(ts: number, now: number): boolean {
  if (!Number.isFinite(ts)) return false;
  if (now - ts >= RECENT_ROOM_TTL_MS) return false;
  if (ts > now + MAX_CLOCK_SKEW_MS) return false;
  return true;
}

function parseRecentRoomItem(item: unknown, now: number): RecentRoomEntry | null {
  const res = RecentRoomRawSchema.safeParse(item);
  if (!res.success) return null;
  const code = res.data.code.trim().toUpperCase();
  if (!isValidRoomCode(code)) return null;
  if (!isTimestampValid(res.data.lastJoinedAt, now)) return null;

  const password = sanitizePassword(res.data.password);
  const label = sanitizeRecentRoomLabel(res.data.label);
  return {
    code,
    role: res.data.role,
    lastJoinedAt: res.data.lastJoinedAt,
    peerNames: sanitizePeerNames(res.data.peerNames),
    ...(password !== undefined ? { password } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/** Sort recent room entries newest-first and cap at `MAX_STORED_RECENT_ROOMS`. */
export function sortAndBoundEntries(entries: RecentRoomEntry[]): RecentRoomEntry[] {
  const sorted = [...entries].sort((a, b) => b.lastJoinedAt - a.lastJoinedAt);
  return sorted.length > MAX_STORED_RECENT_ROOMS ? sorted.slice(0, MAX_STORED_RECENT_ROOMS) : sorted;
}

/** Format a past (or slightly clock-skewed future) timestamp as a relative label. */
export function formatRelativeTime(lastJoinedAt: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - lastJoinedAt) / 1000));
  if (diffSec < 60) return "Just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Filter recent room entries by substring match against code, label, or peer names. */
export function filterRecentRooms(entries: readonly RecentRoomEntry[], query: string): RecentRoomEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(
    (r) =>
      r.code.toLowerCase().includes(q) ||
      (r.label?.toLowerCase().includes(q) ?? false) ||
      r.peerNames.some((name) => name.toLowerCase().includes(q)),
  );
}

function insertEntryOrdered(
  rest: RecentRoomEntry[],
  nextEntry: RecentRoomEntry,
  insertAfterCodes?: readonly string[],
): RecentRoomEntry[] {
  const out = [...rest];
  if (!insertAfterCodes || insertAfterCodes.length === 0) {
    out.unshift(nextEntry);
    return out;
  }
  const afterSet = new Set(insertAfterCodes);
  let insertIdx = 0;
  for (let i = 0; i < out.length; i++) {
    const item = out[i];
    if (item && item.lastJoinedAt === nextEntry.lastJoinedAt && afterSet.has(item.code)) {
      insertIdx = i + 1;
    }
  }
  out.splice(insertIdx, 0, nextEntry);
  return out;
}

/** Build a normalized `RecentRoomEntry` for `recordJoin`, retaining prior password/peers/label when omitted. */
export function buildJoinedRoomEntry(
  code: string,
  role: RecentRoomRole,
  now: number,
  existing: RecentRoomEntry | undefined,
  passwordRaw: string | undefined,
  peerNamesRaw: readonly string[] | undefined,
): RecentRoomEntry {
  const password = sanitizePassword(passwordRaw) ?? existing?.password;
  const incomingPeers = sanitizePeerNames(peerNamesRaw);
  const peerNames = incomingPeers.length > 0 ? incomingPeers : (existing?.peerNames ?? []);
  return {
    code,
    role,
    lastJoinedAt: now,
    peerNames,
    ...(password !== undefined ? { password } : {}),
    ...(existing?.label !== undefined ? { label: existing.label } : {}),
  };
}

/** Merge persisted recent rooms with in-place and promoted pending controller entries. */
export function mergePendingRecentRooms(
  persisted: readonly RecentRoomEntry[],
  inPlace: Map<string, RecentRoomEntry>,
  promoted: readonly RecentRoomEntry[],
  isRemoved: (code: string) => boolean,
  getAfterCodes: (entry: RecentRoomEntry) => readonly string[],
  onPersistedSeen?: (code: string) => void,
): RecentRoomEntry[] {
  const promotedCodes = new Set(promoted.map((entry) => entry.code));
  let merged: RecentRoomEntry[] = [];
  for (const entry of persisted) {
    onPersistedSeen?.(entry.code);
    if (isRemoved(entry.code) || promotedCodes.has(entry.code)) continue;
    merged.push(inPlace.get(entry.code) ?? entry);
    inPlace.delete(entry.code);
  }
  for (const entry of inPlace.values()) merged.push(entry);
  for (let i = promoted.length - 1; i >= 0; i--) {
    const entry = promoted[i];
    if (!entry) continue;
    merged = insertEntryOrdered(merged, entry, getAfterCodes(entry));
  }
  return merged;
}

/** Append legacy `host-rooms` entries absent from `baseEntries` and return sorted, bounded list. */
export function mergeSynthesizedHostRooms(
  baseEntries: readonly RecentRoomEntry[],
  hostRooms: readonly PersistedHostRoom[],
  shouldInclude: (code: string) => boolean,
  onSynthesized?: (code: string) => void,
): RecentRoomEntry[] {
  const seen = new Set(baseEntries.map((entry) => entry.code));
  const merged = [...baseEntries];
  for (const hr of hostRooms) {
    if (seen.has(hr.code) || !shouldInclude(hr.code)) continue;
    seen.add(hr.code);
    onSynthesized?.(hr.code);
    merged.push({
      code: hr.code,
      role: "host",
      lastJoinedAt: hr.updatedAt,
      peerNames: [],
    });
  }
  return sortAndBoundEntries(merged);
}

function persistEntries(storage: StorageLike, entries: RecentRoomEntry[]): RecentRoomEntry[] {
  const bounded = sortAndBoundEntries(entries);
  try {
    if (bounded.length === 0) {
      storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
    } else {
      storage.setItem(RECENT_ROOMS_STORAGE_KEY, JSON.stringify(bounded));
    }
  } catch {
    /* ignore unavailable storage or quota errors */
  }
  return bounded;
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

/** Persist or clear the shared-device opt-out flag (`recent-rooms-disabled`). */
export function setRecentRoomsDisabled(
  storage: StorageLike | null | undefined,
  disabled: boolean,
): void {
  if (!storage) return;
  try {
    if (disabled) {
      storage.setItem(RECENT_ROOMS_OPT_OUT_KEY, "1");
    } else {
      storage.removeItem(RECENT_ROOMS_OPT_OUT_KEY);
    }
  } catch {
    /* ignore unavailable storage errors */
  }
}

/** Load, validate, prune expired/skewed, and sort recent room entries (newest first). */
export function loadRecentRooms(
  storage: StorageLike | null | undefined,
  now: number = Date.now(),
): RecentRoomEntry[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(RECENT_ROOMS_STORAGE_KEY);
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

  const byCode = new Map<string, RecentRoomEntry>();
  for (const item of parsed) {
    const entry = parseRecentRoomItem(item, now);
    if (!entry) continue;
    const existing = byCode.get(entry.code);
    if (!existing || entry.lastJoinedAt >= existing.lastJoinedAt) {
      byCode.set(entry.code, entry);
    }
  }
  return sortAndBoundEntries([...byCode.values()]);
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

/** Remove all persisted entries from `recent-rooms` in `storage`. */
export function clearAllPersistedRecentRooms(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(RECENT_ROOMS_STORAGE_KEY);
  } catch {
    /* ignore unavailable storage errors */
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
