import { isValidRoomCode, z } from "@shared/protocol";
import type { PersistedHostRoom } from "./host-tokens";

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

export type RecentRoomPatchOp =
  | { kind: "patch"; code: string; field: "password"; password: string }
  | { kind: "patch"; code: string; field: "peerNames"; peerNames: string[] }
  | { kind: "patch"; code: string; field: "label"; label?: string };

export interface RecentRoomJoinOp {
  code: string;
  role: RecentRoomRole;
  lastJoinedAt: number;
  password?: string;
  peerNames?: string[];
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
  return Number.isFinite(ts) && now - ts < RECENT_ROOM_TTL_MS && ts <= now + MAX_CLOCK_SKEW_MS;
}

/** Validate and normalize a raw stored recent-room record against schema, room code, and TTL. */
export function parseRecentRoomItem(item: unknown, now: number): RecentRoomEntry | null {
  const res = RecentRoomRawSchema.safeParse(item);
  if (!res.success) return null;
  const code = res.data.code.trim().toUpperCase();
  if (!isValidRoomCode(code) || !isTimestampValid(res.data.lastJoinedAt, now)) return null;

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
export function sortAndBoundEntries(entries: readonly RecentRoomEntry[]): RecentRoomEntry[] {
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
  return `${Math.floor(hrs / 24)}d ago`;
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

/** Apply a single field patch to `base` without modifying unrelated fields or `lastJoinedAt`. */
export function applyPatchToEntry(base: RecentRoomEntry, op: RecentRoomPatchOp): RecentRoomEntry {
  const peerNames = [...base.peerNames];
  switch (op.field) {
    case "password":
      return { ...base, peerNames, password: op.password };
    case "peerNames":
      return { ...base, peerNames: [...op.peerNames] };
    case "label": {
      const { label: _prev, ...withoutLabel } = base;
      return op.label !== undefined ? { ...withoutLabel, peerNames, label: op.label } : { ...withoutLabel, peerNames };
    }
  }
}

/** Append legacy `host-rooms` entries absent from `baseEntries` and return sorted, bounded list. */
export function mergeSynthesizedHostRooms(
  baseEntries: readonly RecentRoomEntry[],
  hostRooms: readonly PersistedHostRoom[],
  shouldInclude: (code: string) => boolean,
): RecentRoomEntry[] {
  const seen = new Set(baseEntries.map((entry) => entry.code));
  const merged = [...baseEntries];
  for (const hr of hostRooms) {
    if (seen.has(hr.code) || !shouldInclude(hr.code)) continue;
    seen.add(hr.code);
    merged.push({
      code: hr.code,
      role: "host",
      lastJoinedAt: hr.updatedAt,
      peerNames: [],
    });
  }
  return sortAndBoundEntries(merged);
}

function isSameEntry(a: RecentRoomEntry, b: RecentRoomEntry): boolean {
  return (
    a.role === b.role &&
    a.password === b.password &&
    a.label === b.label &&
    a.peerNames.length === b.peerNames.length &&
    a.peerNames.every((v, i) => v === b.peerNames[i])
  );
}

/** Upsert a room join into `entries`, preserving omitted fields and returning null if timestamp is invalid. */
export function upsertJoinEntry(
  entries: readonly RecentRoomEntry[],
  op: RecentRoomJoinOp,
  now: number,
): RecentRoomEntry[] | null {
  if (!isTimestampValid(op.lastJoinedAt, now)) return null;
  const existing = entries.find((e) => e.code === op.code);
  const cleanPw = sanitizePassword(op.password);
  const cleanPeers = sanitizePeerNames(op.peerNames);
  const password = cleanPw ?? existing?.password;
  const peerNames = cleanPeers.length > 0 ? cleanPeers : [...(existing?.peerNames ?? [])];
  const lastJoinedAt = existing ? Math.max(op.lastJoinedAt, existing.lastJoinedAt) : op.lastJoinedAt;
  const nextEntry: RecentRoomEntry = {
    code: op.code,
    role: op.role,
    lastJoinedAt,
    peerNames,
    ...(password !== undefined ? { password } : {}),
    ...(existing?.label !== undefined ? { label: existing.label } : {}),
  };
  return sortAndBoundEntries([nextEntry, ...entries.filter((e) => e.code !== op.code)]);
}

/** Apply a field patch to `entries` (or synthesize from a valid `host-rooms` entry), returning null if unchanged. */
export function patchEntryInList(
  entries: readonly RecentRoomEntry[],
  op: RecentRoomPatchOp,
  now: number,
  hostRooms: readonly PersistedHostRoom[],
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomEntry[] | null {
  const idx = entries.findIndex((e) => e.code === op.code);
  const existing = idx !== -1 ? entries[idx] : undefined;
  if (existing) {
    const patched = applyPatchToEntry(existing, op);
    if (isSameEntry(existing, patched)) return null;
    return entries.map((e, i) => (i === idx ? patched : e));
  }
  const hostRoom = hostRooms.find((hr) => hr.code === op.code);
  if (!hostRoom || !hasSavedCreatorHostFor(op.code) || !isTimestampValid(hostRoom.updatedAt, now)) {
    return null;
  }
  const base: RecentRoomEntry = {
    code: op.code,
    role: "host",
    lastJoinedAt: hostRoom.updatedAt,
    peerNames: [],
  };
  return sortAndBoundEntries([applyPatchToEntry(base, op), ...entries]);
}

/** Remove `code` from `entries` (or demote `"host"` to `"guest"` if `demoteIfPassworded`), returning null if unchanged. */
export function removeEntryFromList(
  entries: readonly RecentRoomEntry[],
  code: string,
  demoteIfPassworded: boolean,
): RecentRoomEntry[] | null {
  const existing = entries.find((e) => e.code === code);
  if (!existing) return null;
  if (demoteIfPassworded && existing.password !== undefined) {
    if (existing.role === "guest") return null;
    return entries.map((e) => (e.code === code ? { ...e, peerNames: [...e.peerNames], role: "guest" as const } : e));
  }
  return entries.filter((e) => e.code !== code);
}
