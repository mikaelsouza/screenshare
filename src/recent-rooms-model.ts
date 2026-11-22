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

export type RecentRoomField = "password" | "peerNames" | "label" | "role";

/** Ordered list of patchable recent-room metadata fields. */
export const RECENT_ROOM_FIELDS: readonly RecentRoomField[] = ["role", "password", "peerNames", "label"];

export type RecentRoomPatchOp =
  | { kind: "patch"; code: string; field: "password"; password: string }
  | { kind: "patch"; code: string; field: "peerNames"; peerNames: string[] }
  | { kind: "patch"; code: string; field: "label"; label?: string; clearLabel?: boolean }
  | { kind: "patch"; code: string; field: "role"; role: RecentRoomRole };

export interface RecentRoomJoinOp {
  kind: "join";
  code: string;
  role: RecentRoomRole;
  lastJoinedAt: number;
  password?: string;
  peerNames?: string[];
}

export type RecentRoomWriteOp = RecentRoomJoinOp | RecentRoomPatchOp;

export type PendingPatchMap = {
  [F in RecentRoomField]?: { gen: number; op: Extract<RecentRoomPatchOp, { field: F }> };
};

export type PersistedFieldGens = Partial<Record<RecentRoomField, number>>;

export interface RecentRoomsSyncState {
  readonly pendingRemovals: Map<string, number>;
  readonly lastRemovalGen: Map<string, number>;
  readonly persistedRemovalGen: Map<string, number>;
  readonly lastWriteGen: Map<string, number>;
  readonly lastJoinGen: Map<string, number>;
  readonly persistedJoinGen: Map<string, number>;
  readonly pendingJoins: Map<string, RecentRoomJoinOp & { gen: number; firstGen: number; failed?: boolean }>;
  readonly pendingSynthPromotions: Map<string, number>;
  readonly preJoinSynthGen: Map<string, number>;
  readonly pendingPatches: Map<string, PendingPatchMap>;
  readonly persistedFieldGen: Map<string, PersistedFieldGens>;
  readonly lastExternalDeleteGen: Map<string, number>;
  readonly synthesizedCodes: Set<string>;
}

/** Create empty generation and pending-op tracking maps for `RecentRoomsController`. */
export function createRecentRoomsSyncState(): RecentRoomsSyncState {
  return {
    pendingRemovals: new Map(),
    lastRemovalGen: new Map(),
    persistedRemovalGen: new Map(),
    lastWriteGen: new Map(),
    lastJoinGen: new Map(),
    persistedJoinGen: new Map(),
    pendingJoins: new Map(),
    pendingSynthPromotions: new Map(),
    preJoinSynthGen: new Map(),
    pendingPatches: new Map(),
    persistedFieldGen: new Map(),
    lastExternalDeleteGen: new Map(),
    synthesizedCodes: new Set(),
  };
}

export interface PendingFieldOverlay {
  password?: string;
  peerNames?: string[];
  label?: string;
  clearLabel?: boolean;
  role?: RecentRoomRole;
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
export function isTimestampValid(ts: number, now: number): boolean {
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

/** Insert `nextEntry` at the front or immediately after any same-ms code in `insertAfterCodes`. */
export function insertEntryOrdered(
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

/** Record a pending field patch for `code` at generation `gen`. */
export function setPendingPatchInMap(
  byCode: Map<string, PendingPatchMap>,
  code: string,
  gen: number,
  op: RecentRoomPatchOp,
): void {
  const patches = byCode.get(code) ?? {};
  switch (op.field) {
    case "password":
      patches.password = { gen, op };
      break;
    case "peerNames":
      patches.peerNames = { gen, op };
      break;
    case "label":
      patches.label = { gen, op };
      break;
    case "role":
      patches.role = { gen, op };
      break;
  }
  byCode.set(code, patches);
}

/** Convert pending field patches for a room into a sparse overlay for `syncFromStorage`. */
export function buildFieldOverlayFromPatches(patches: PendingPatchMap | undefined): PendingFieldOverlay | null {
  if (!patches) return null;
  const overlay: PendingFieldOverlay = {};
  let hasField = false;
  if (patches.role) {
    overlay.role = patches.role.op.role;
    hasField = true;
  }
  if (patches.password) {
    overlay.password = patches.password.op.password;
    hasField = true;
  }
  if (patches.peerNames) {
    overlay.peerNames = patches.peerNames.op.peerNames;
    hasField = true;
  }
  if (patches.label) {
    if (patches.label.op.clearLabel) overlay.clearLabel = true;
    else if (patches.label.op.label !== undefined) overlay.label = patches.label.op.label;
    hasField = true;
  }
  return hasField ? overlay : null;
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
    case "role":
      return { ...base, peerNames, role: op.role };
  }
}

function pickJoinValue<T>(
  val: T | undefined,
  joinGen: number,
  persistedGen: number | undefined,
  fallback: T,
): T {
  return val !== undefined && joinGen >= (persistedGen ?? 0) ? val : fallback;
}

/** Build a materialized recent-room entry from an unpersisted `recordJoin` and optional disk baseline. */
export function buildMaterializedJoinEntry(
  pendingJoin: RecentRoomJoinOp & { gen: number },
  existing: RecentRoomEntry | undefined,
  fieldGens: PersistedFieldGens | undefined,
): RecentRoomEntry {
  const role = pickJoinValue(pendingJoin.role, pendingJoin.gen, fieldGens?.role, existing?.role ?? pendingJoin.role);
  const password = pickJoinValue(pendingJoin.password, pendingJoin.gen, fieldGens?.password, existing?.password);
  const peerNames = pickJoinValue(pendingJoin.peerNames, pendingJoin.gen, fieldGens?.peerNames, existing?.peerNames ?? []);
  return {
    code: pendingJoin.code,
    role,
    lastJoinedAt: pendingJoin.lastJoinedAt,
    peerNames: [...peerNames],
    ...(password !== undefined ? { password } : {}),
    ...(existing?.label !== undefined ? { label: existing.label } : {}),
  };
}

/** Compute next persisted room list for a `recordJoin` operation without clobbering newer cross-tab fields. */
export function planJoinPersistence(
  entries: readonly RecentRoomEntry[],
  joinOp: RecentRoomJoinOp & { gen: number },
  fieldGens: PersistedFieldGens | undefined,
  afterCodes: readonly string[],
): RecentRoomEntry[] {
  const existing = entries.find((e) => e.code === joinOp.code);
  const nextEntry = buildMaterializedJoinEntry(joinOp, existing, fieldGens);
  const rest = entries.filter((e) => e.code !== joinOp.code);
  return insertEntryOrdered(rest, nextEntry, afterCodes);
}

/** Return true when a queued patch should apply over a materialized `pendingJoin`. */
export function shouldApplyPatchOverJoin(
  op: RecentRoomPatchOp,
  opGen: number,
  pendingJoin: RecentRoomJoinOp & { gen: number },
  fieldGens: PersistedFieldGens | undefined,
): boolean {
  if (opGen > pendingJoin.gen || op.field === "label") return true;
  if (op.field === "role") return false;
  const joinVal = op.field === "password" ? pendingJoin.password : pendingJoin.peerNames;
  return joinVal === undefined && opGen >= (fieldGens?.[op.field] ?? 0);
}

/** Compute next persisted room list for a metadata patch, or return null if absent from disk without an unpersisted join. */
export function planPatchPersistence(
  entries: readonly RecentRoomEntry[],
  op: RecentRoomPatchOp,
  opGen: number,
  pendingJoin: (RecentRoomJoinOp & { gen: number }) | undefined,
  hasPendingJoin: boolean,
  fieldGens: PersistedFieldGens | undefined,
  afterCodes: readonly string[],
): RecentRoomEntry[] | null {
  const existing = entries.find((e) => e.code === op.code);
  if (existing && (!hasPendingJoin || !pendingJoin)) {
    const nextEntry = applyPatchToEntry(existing, op);
    return entries.map((e) => (e.code === op.code ? nextEntry : e));
  }
  if (hasPendingJoin && pendingJoin) {
    const materialized = buildMaterializedJoinEntry(pendingJoin, existing, fieldGens);
    const nextEntry = shouldApplyPatchOverJoin(op, opGen, pendingJoin, fieldGens) ? applyPatchToEntry(materialized, op) : materialized;
    return insertEntryOrdered(entries.filter((e) => e.code !== op.code), nextEntry, afterCodes);
  }
  return null;
}

/** Overlay pending local field edits onto a persisted entry without clobbering newer cross-tab fields. */
function applyOverlayToEntry(base: RecentRoomEntry, overlay: PendingFieldOverlay): RecentRoomEntry {
  const { label: baseLabel, ...withoutLabel } = base;
  const nextLabel = overlay.clearLabel ? undefined : (overlay.label ?? baseLabel);
  return {
    ...withoutLabel,
    role: overlay.role ?? base.role,
    peerNames: overlay.peerNames !== undefined ? [...overlay.peerNames] : base.peerNames,
    ...(overlay.password !== undefined
      ? { password: overlay.password }
      : base.password !== undefined
        ? { password: base.password }
        : {}),
    ...(nextLabel !== undefined ? { label: nextLabel } : {}),
  };
}

/** Merge persisted recent rooms with in-place field overlays and promoted pending entries. */
export function mergePendingRecentRooms(
  persisted: readonly RecentRoomEntry[],
  inPlace: Map<string, PendingFieldOverlay>,
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
    const overlay = inPlace.get(entry.code);
    merged.push(overlay ? applyOverlayToEntry(entry, overlay) : entry);
  }
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

/** Return true if a room has an in-tab join whose generation has not yet been persisted. */
export function hasUnpersistedJoin(state: RecentRoomsSyncState, code: string): boolean {
  return (state.lastJoinGen.get(code) ?? 0) > (state.persistedJoinGen.get(code) ?? 0);
}

/** Return codes of rooms persisted with a join generation newer than `targetGen` for tie-breaking order. */
export function afterCodesForJoin(state: RecentRoomsSyncState, code: string, targetGen: number): string[] {
  const after: string[] = [];
  for (const [otherCode, persistedGen] of state.persistedJoinGen) {
    if (otherCode !== code && persistedGen > targetGen) after.push(otherCode);
  }
  return after;
}

/** Mark `field` for `code` as persisted at `gen` and prune satisfied pending patches. */
export function markPersistedField(
  state: RecentRoomsSyncState,
  code: string,
  field: RecentRoomField,
  gen: number,
): void {
  const map = state.persistedFieldGen.get(code) ?? {};
  if (gen > (map[field] ?? 0)) {
    map[field] = gen;
    state.persistedFieldGen.set(code, map);
  }
  const patches = state.pendingPatches.get(code);
  if (patches && (patches[field]?.gen ?? 0) <= gen) {
    delete patches[field];
    if (Object.keys(patches).length === 0) state.pendingPatches.delete(code);
  }
}

/** Mark an in-tab `recordJoin` operation as persisted in `state`. */
export function markMaterializedPendingJoin(
  state: RecentRoomsSyncState,
  pendingJoin: RecentRoomJoinOp & { gen: number; firstGen?: number },
): void {
  state.persistedJoinGen.set(pendingJoin.code, Math.max(state.persistedJoinGen.get(pendingJoin.code) ?? 0, pendingJoin.gen));
  if (state.pendingJoins.get(pendingJoin.code)?.gen === pendingJoin.gen) {
    state.pendingJoins.delete(pendingJoin.code);
  }
  const synthGen = state.pendingSynthPromotions.get(pendingJoin.code);
  if (synthGen !== undefined && pendingJoin.firstGen !== undefined && synthGen < pendingJoin.firstGen) {
    state.preJoinSynthGen.set(pendingJoin.code, Math.max(state.preJoinSynthGen.get(pendingJoin.code) ?? 0, pendingJoin.firstGen - 1));
  }
  state.pendingSynthPromotions.delete(pendingJoin.code);
  markPersistedField(state, pendingJoin.code, "role", pendingJoin.gen);
  if (pendingJoin.password !== undefined) markPersistedField(state, pendingJoin.code, "password", pendingJoin.gen);
  if (pendingJoin.peerNames !== undefined) markPersistedField(state, pendingJoin.code, "peerNames", pendingJoin.gen);
}

function resolvePreJoinExternalDeleteCutoff(state: RecentRoomsSyncState, code: string, failedGen: number): number | undefined {
  const pendingJoin = state.pendingJoins.get(code);
  const synthGen = state.pendingSynthPromotions.get(code);
  if (pendingJoin && pendingJoin.gen > failedGen && synthGen !== undefined && synthGen <= failedGen && synthGen < pendingJoin.firstGen) {
    return pendingJoin.firstGen - 1;
  }
  const preSynth = state.preJoinSynthGen.get(code);
  return preSynth !== undefined && preSynth > failedGen ? preSynth : undefined;
}

function prunePendingPatchesUpTo(state: RecentRoomsSyncState, code: string, maxGen: number): void {
  const patches = state.pendingPatches.get(code);
  if (!patches) return;
  for (const field of RECENT_ROOM_FIELDS) {
    if ((patches[field]?.gen ?? 0) <= maxGen) delete patches[field];
  }
  if (Object.keys(patches).length === 0) state.pendingPatches.delete(code);
}

/** Clear pending ops at or below `failedGen` when a room was deleted externally from storage. */
export function clearPendingStateOnExternalDelete(state: RecentRoomsSyncState, code: string, failedGen: number): void {
  const preJoinBoundary = resolvePreJoinExternalDeleteCutoff(state, code, failedGen);
  const effectiveGen = preJoinBoundary === undefined ? failedGen : Math.max(failedGen, preJoinBoundary);
  if (effectiveGen > (state.lastExternalDeleteGen.get(code) ?? 0)) state.lastExternalDeleteGen.set(code, effectiveGen);
  prunePendingPatchesUpTo(state, code, effectiveGen);
  const pendingJoin = state.pendingJoins.get(code);
  if (pendingJoin && pendingJoin.gen <= failedGen) state.pendingJoins.delete(code);
  const synthGen = state.pendingSynthPromotions.get(code);
  if (synthGen !== undefined && synthGen <= effectiveGen) state.pendingSynthPromotions.delete(code);
  if (preJoinBoundary !== undefined) {
    state.preJoinSynthGen.set(code, Math.max(state.preJoinSynthGen.get(code) ?? 0, preJoinBoundary));
  } else if ((state.preJoinSynthGen.get(code) ?? Infinity) <= failedGen) {
    state.preJoinSynthGen.delete(code);
  }
}

/** Return true if `code` has a local deletion not yet superseded by a newer join or clearAll. */
export function isCodeLocallyRemoved(
  state: RecentRoomsSyncState,
  code: string,
  persistedClearAllGen: number,
): boolean {
  if (state.pendingRemovals.has(code)) return true;
  const removedGen = state.lastRemovalGen.get(code) ?? 0;
  const satisfiedBy = Math.max(
    state.persistedRemovalGen.get(code) ?? 0,
    persistedClearAllGen,
    state.lastJoinGen.get(code) ?? 0,
  );
  return removedGen > satisfiedBy;
}
