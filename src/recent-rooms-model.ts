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
  kind: "join";
  code: string;
  role: RecentRoomRole;
  lastJoinedAt: number;
  password?: string;
  peerNames?: string[];
}

export type RecentRoomOp =
  | RecentRoomJoinOp
  | RecentRoomPatchOp
  | { kind: "remove"; code: string; demoteIfPassworded?: boolean }
  | { kind: "clear-all" }
  | { kind: "set-disabled"; disabled: boolean };

export interface RecentRoomsSnapshot {
  entries: RecentRoomEntry[];
  disabled: boolean;
}

export interface RecentRoomOpOutcome {
  snapshot: RecentRoomsSnapshot;
  changed: boolean;
  missing: boolean;
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

/** Return true if a stored/input timestamp is finite and within TTL and forward clock skew bounds. */
function isTimestampValid(ts: number, now: number): boolean {
  if (!Number.isFinite(ts)) return false;
  if (now - ts >= RECENT_ROOM_TTL_MS) return false;
  if (ts > now + MAX_CLOCK_SKEW_MS) return false;
  return true;
}

/** Validate and normalize a raw stored recent-room record against schema, room code, and TTL. */
export function parseRecentRoomItem(item: unknown, now: number): RecentRoomEntry | null {
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

function cloneEntry(entry: RecentRoomEntry): RecentRoomEntry {
  return { ...entry, peerNames: [...entry.peerNames] };
}

function cloneSnapshot(snapshot: RecentRoomsSnapshot): RecentRoomsSnapshot {
  return {
    entries: snapshot.entries.map(cloneEntry),
    disabled: snapshot.disabled,
  };
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isSameEntry(a: RecentRoomEntry, b: RecentRoomEntry): boolean {
  return (
    a.role === b.role &&
    a.password === b.password &&
    a.label === b.label &&
    sameStringArray(a.peerNames, b.peerNames)
  );
}

function applyJoinOp(snapshot: RecentRoomsSnapshot, op: RecentRoomJoinOp, now: number): RecentRoomOpOutcome {
  if (snapshot.disabled || !isTimestampValid(op.lastJoinedAt, now)) {
    return { snapshot: cloneSnapshot(snapshot), changed: false, missing: false };
  }
  const existing = snapshot.entries.find((e) => e.code === op.code);
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
  const rest = snapshot.entries.filter((e) => e.code !== op.code).map(cloneEntry);
  return {
    snapshot: { entries: sortAndBoundEntries([nextEntry, ...rest]), disabled: false },
    changed: true,
    missing: false,
  };
}

function applyPatchOp(
  snapshot: RecentRoomsSnapshot,
  op: RecentRoomPatchOp,
  now: number,
  hostRooms: readonly PersistedHostRoom[],
  hasSavedCreatorHostFor: (code: string) => boolean,
  allowHostSynthesis: boolean = true,
): RecentRoomOpOutcome {
  if (snapshot.disabled) {
    return { snapshot: cloneSnapshot(snapshot), changed: false, missing: false };
  }
  const idx = snapshot.entries.findIndex((e) => e.code === op.code);
  const existing = idx !== -1 ? snapshot.entries[idx] : undefined;
  if (existing) {
    const patched = applyPatchToEntry(existing, op);
    if (isSameEntry(existing, patched)) {
      return { snapshot: cloneSnapshot(snapshot), changed: false, missing: false };
    }
    const entries = snapshot.entries.map((e, i) => (i === idx ? patched : cloneEntry(e)));
    return { snapshot: { entries, disabled: false }, changed: true, missing: false };
  }
  if (!allowHostSynthesis) {
    return { snapshot: cloneSnapshot(snapshot), changed: false, missing: true };
  }
  const hostRoom = hostRooms.find((hr) => hr.code === op.code);
  if (!hostRoom || !hasSavedCreatorHostFor(op.code) || !isTimestampValid(hostRoom.updatedAt, now)) {
    return { snapshot: cloneSnapshot(snapshot), changed: false, missing: true };
  }
  const base: RecentRoomEntry = {
    code: op.code,
    role: "host",
    lastJoinedAt: hostRoom.updatedAt,
    peerNames: [],
  };
  const patched = applyPatchToEntry(base, op);
  return {
    snapshot: { entries: sortAndBoundEntries([patched, ...snapshot.entries.map(cloneEntry)]), disabled: false },
    changed: true,
    missing: false,
  };
}

function applyRemoveOp(
  snapshot: RecentRoomsSnapshot,
  code: string,
  demoteIfPassworded: boolean,
): RecentRoomOpOutcome {
  const existing = snapshot.entries.find((e) => e.code === code);
  if (!existing) {
    return { snapshot: cloneSnapshot(snapshot), changed: false, missing: false };
  }
  if (demoteIfPassworded && existing.password !== undefined) {
    if (existing.role === "guest") {
      return { snapshot: cloneSnapshot(snapshot), changed: false, missing: false };
    }
    const entries = snapshot.entries.map((e) =>
      e.code === code ? { ...cloneEntry(e), role: "guest" as const } : cloneEntry(e),
    );
    return { snapshot: { entries, disabled: snapshot.disabled }, changed: true, missing: false };
  }
  return {
    snapshot: {
      entries: snapshot.entries.filter((e) => e.code !== code).map(cloneEntry),
      disabled: snapshot.disabled,
    },
    changed: true,
    missing: false,
  };
}

function applyClearAllOp(snapshot: RecentRoomsSnapshot): RecentRoomOpOutcome {
  return {
    snapshot: { entries: [], disabled: snapshot.disabled },
    changed: snapshot.entries.length > 0,
    missing: false,
  };
}

function applySetDisabledOp(snapshot: RecentRoomsSnapshot, disabled: boolean): RecentRoomOpOutcome {
  const entries = disabled ? [] : snapshot.entries.map(cloneEntry);
  const changed = snapshot.disabled !== disabled || (disabled && snapshot.entries.length > 0);
  return {
    snapshot: { entries, disabled },
    changed,
    missing: false,
  };
}

function applyOpWithSynthesis(
  snapshot: RecentRoomsSnapshot,
  op: RecentRoomOp,
  now: number,
  hostRooms: readonly PersistedHostRoom[],
  hasSavedCreatorHostFor: (code: string) => boolean,
  allowHostSynthesis: boolean,
): RecentRoomOpOutcome {
  switch (op.kind) {
    case "join":
      return applyJoinOp(snapshot, op, now);
    case "patch":
      return applyPatchOp(snapshot, op, now, hostRooms, hasSavedCreatorHostFor, allowHostSynthesis);
    case "remove":
      return applyRemoveOp(snapshot, op.code, op.demoteIfPassworded === true);
    case "clear-all":
      return applyClearAllOp(snapshot);
    case "set-disabled":
      return applySetDisabledOp(snapshot, op.disabled);
  }
}

/** Apply a single queued recent-room operation purely against `snapshot` without mutating inputs. */
export function applyRecentRoomOp(
  snapshot: RecentRoomsSnapshot,
  op: RecentRoomOp,
  now: number,
  hostRooms: readonly PersistedHostRoom[],
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomOpOutcome {
  return applyOpWithSynthesis(snapshot, op, now, hostRooms, hasSavedCreatorHostFor, true);
}

function shouldSuppressAfterRemove(
  current: RecentRoomsSnapshot,
  code: string,
  demoteIfPassworded: boolean,
): boolean {
  if (!demoteIfPassworded) return true;
  return !current.entries.some((e) => e.code === code && e.password !== undefined);
}

function replayOpsWithTracking(
  initial: RecentRoomsSnapshot,
  ops: readonly RecentRoomOp[],
  now: number,
  hostRooms: readonly PersistedHostRoom[],
  hasSavedCreatorHostFor: (code: string) => boolean,
): { snapshot: RecentRoomsSnapshot; locallyRemoved: Set<string> } {
  let current = cloneSnapshot(initial);
  const locallyRemoved = new Set<string>();
  for (const op of ops) {
    if (op.kind === "clear-all" || (op.kind === "set-disabled" && op.disabled)) {
      locallyRemoved.clear();
    } else if (op.kind === "remove" && shouldSuppressAfterRemove(current, op.code, op.demoteIfPassworded === true)) {
      locallyRemoved.add(op.code);
    }
    const allowHostSynthesis = op.kind !== "patch" || !locallyRemoved.has(op.code);
    current = applyOpWithSynthesis(current, op, now, hostRooms, hasSavedCreatorHostFor, allowHostSynthesis).snapshot;
    if (op.kind === "join" && current.entries.some((e) => e.code === op.code)) {
      locallyRemoved.delete(op.code);
    }
  }
  return { snapshot: current, locallyRemoved };
}

/** Compute the effective UI snapshot by replaying `queue` over `diskSnapshot` and merging legacy `host-rooms`. */
export function computeRecentRoomsView(
  diskSnapshot: RecentRoomsSnapshot,
  queue: readonly RecentRoomOp[],
  now: number,
  hostRooms: readonly PersistedHostRoom[],
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomsSnapshot {
  const { snapshot: replayed, locallyRemoved } = replayOpsWithTracking(
    diskSnapshot,
    queue,
    now,
    hostRooms,
    hasSavedCreatorHostFor,
  );
  if (replayed.disabled) {
    return { entries: [], disabled: true };
  }
  return {
    entries: mergeSynthesizedHostRooms(
      replayed.entries,
      hostRooms.filter((hr) => !locallyRemoved.has(hr.code)),
      hasSavedCreatorHostFor,
    ),
    disabled: false,
  };
}
