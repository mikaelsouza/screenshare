import { listPersistedHostRooms, type StorageLike } from "./host-tokens";
import { removePersistedRecentRoom, tryLoadRecentRooms, writePersistedRecentRooms } from "./recent-rooms";
import {
  RECENT_ROOM_FIELDS,
  afterCodesForJoin,
  applyPatchToEntry,
  buildFieldOverlayFromPatches,
  buildMaterializedJoinEntry,
  clearPendingStateOnExternalDelete,
  hasUnpersistedJoin,
  insertEntryOrdered,
  isCodeLocallyRemoved,
  markMaterializedPendingJoin,
  markPersistedField,
  mergePendingRecentRooms,
  mergeSynthesizedHostRooms,
  planJoinPersistence,
  planPatchPersistence,
  shouldApplyPatchOverJoin,
  type PendingFieldOverlay,
  type PendingPatchMap,
  type PersistedFieldGens,
  type RecentRoomEntry,
  type RecentRoomField,
  type RecentRoomJoinOp,
  type RecentRoomPatchOp,
  type RecentRoomWriteOp,
  type RecentRoomsSyncState,
} from "./recent-rooms-model";

export type RecentRoomPersistResult = "ok" | "failed" | "missing-on-disk";

/** Clear pending in-tab write/join/patch/removal sync maps on local `clearAll` or external opt-out. */
export function resetRecentRoomsSyncMaps(state: RecentRoomsSyncState): void {
  state.lastJoinGen.clear();
  state.pendingJoins.clear();
  state.pendingSynthPromotions.clear();
  state.preJoinSynthGen.clear();
  state.pendingPatches.clear();
  state.pendingRemovals.clear();
  state.persistedFieldGen.clear();
  state.lastExternalDeleteGen.clear();
  state.synthesizedCodes.clear();
}

/** Clear per-room pending join/patch sync maps when `code` is removed locally. */
export function clearCodeFromSyncMaps(state: RecentRoomsSyncState, code: string): void {
  state.lastJoinGen.delete(code);
  state.pendingJoins.delete(code);
  state.pendingSynthPromotions.delete(code);
  state.pendingPatches.delete(code);
  state.synthesizedCodes.delete(code);
}

function hasLiveCreatorHostRoom(
  storage: StorageLike | null | undefined,
  code: string,
  now: number,
  hasSavedCreatorHostFor: (code: string) => boolean,
): boolean {
  return hasSavedCreatorHostFor(code) && listPersistedHostRooms(storage, now).some((hr) => hr.code === code);
}

function rollbackLastJoinGen(state: RecentRoomsSyncState, code: string, gen: number): void {
  if ((state.lastJoinGen.get(code) ?? 0) > gen) return;
  const rollbackGen = Math.max(state.persistedJoinGen.get(code) ?? 0, state.pendingSynthPromotions.get(code) ?? 0);
  if (rollbackGen > 0) state.lastJoinGen.set(code, rollbackGen);
  else state.lastJoinGen.delete(code);
}

function dropFailedPatchState(
  state: RecentRoomsSyncState,
  code: string,
  field: RecentRoomField,
  gen: number,
): void {
  const patches = state.pendingPatches.get(code);
  if (patches && (patches[field]?.gen ?? 0) <= gen) {
    delete patches[field];
    if (Object.keys(patches).length === 0) state.pendingPatches.delete(code);
  }
  const synthGen = state.pendingSynthPromotions.get(code);
  if (
    synthGen !== undefined &&
    synthGen <= gen &&
    !state.pendingJoins.has(code) &&
    !state.pendingPatches.has(code)
  ) {
    state.pendingSynthPromotions.delete(code);
    rollbackLastJoinGen(state, code, gen);
  }
}

function dropFailedJoinState(state: RecentRoomsSyncState, code: string, gen: number): void {
  const pending = state.pendingJoins.get(code);
  if (!pending || pending.gen !== gen) return;
  state.pendingJoins.set(code, { ...pending, failed: true });
  rollbackLastJoinGen(state, code, gen);
}

/** Drop failed join or patch state at `gen`; returns true when `syncFromStorage` should reconcile. */
export function dropFailedWriteOp(state: RecentRoomsSyncState, op: RecentRoomWriteOp, gen: number): boolean {
  if (op.kind === "patch") {
    dropFailedPatchState(state, op.code, op.field, gen);
    return true;
  }
  dropFailedJoinState(state, op.code, gen);
  return false;
}

/** Remove previously failed `pendingJoins` entries during `syncFromStorage` reconciliation. */
export function pruneFailedPendingJoins(state: RecentRoomsSyncState): void {
  for (const [code, pending] of state.pendingJoins) {
    if (!pending.failed) continue;
    state.pendingJoins.delete(code);
    if ((state.lastWriteGen.get(code) ?? 0) <= pending.gen) {
      state.lastWriteGen.delete(code);
    }
  }
}

function persistJoinOp(
  storage: StorageLike | null | undefined,
  state: RecentRoomsSyncState,
  op: RecentRoomJoinOp,
  gen: number,
  now: number,
): RecentRoomPersistResult {
  const loaded = tryLoadRecentRooms(storage, now);
  if (!loaded.ok) return "failed";
  const prevFirstGen = state.pendingJoins.get(op.code)?.firstGen;
  const joinOp = { ...op, gen, ...(prevFirstGen !== undefined ? { firstGen: prevFirstGen } : {}) };
  const nextEntries = planJoinPersistence(
    loaded.entries,
    joinOp,
    state.persistedFieldGen.get(op.code),
    afterCodesForJoin(state, op.code, gen),
  );
  if (!writePersistedRecentRooms(storage, nextEntries)) return "failed";
  markMaterializedPendingJoin(state, joinOp);
  return "ok";
}

function persistSynthPatch(
  storage: StorageLike | null | undefined,
  state: RecentRoomsSyncState,
  loadedEntries: RecentRoomEntry[],
  op: RecentRoomPatchOp,
  gen: number,
  now: number,
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomPersistResult {
  const synthGen = state.pendingSynthPromotions.get(op.code);
  if (synthGen === undefined || synthGen > gen || !hasUnpersistedJoin(state, op.code)) return "missing-on-disk";
  const hostRoom = listPersistedHostRooms(storage, now).find((hr) => hr.code === op.code);
  if (!hostRoom || !hasSavedCreatorHostFor(op.code)) return "missing-on-disk";
  const base: RecentRoomEntry = { code: op.code, role: "host", lastJoinedAt: hostRoom.updatedAt, peerNames: [] };
  const nextEntries = insertEntryOrdered(
    loadedEntries,
    applyPatchToEntry(base, op),
    afterCodesForJoin(state, op.code, synthGen),
  );
  if (!writePersistedRecentRooms(storage, nextEntries)) return "failed";
  state.persistedJoinGen.set(op.code, synthGen);
  state.pendingSynthPromotions.delete(op.code);
  markPersistedField(state, op.code, op.field, gen);
  return "ok";
}

function isPreDeleteSynthPatch(
  state: RecentRoomsSyncState,
  code: string,
  gen: number,
  pendingJoin: (RecentRoomJoinOp & { gen: number; firstGen: number }) | undefined,
  synthGen: number | undefined,
): boolean {
  if (pendingJoin !== undefined && pendingJoin.firstGen > gen && synthGen !== undefined && synthGen <= gen) {
    return true;
  }
  const preJoinSynth = state.preJoinSynthGen.get(code);
  return preJoinSynth !== undefined && gen <= preJoinSynth;
}

function shouldUsePendingJoinForPatch(
  state: RecentRoomsSyncState,
  code: string,
  gen: number,
  pendingJoin: (RecentRoomJoinOp & { gen: number; firstGen: number; failed?: boolean }) | undefined,
  synthGen: number | undefined,
): boolean {
  if (pendingJoin === undefined || pendingJoin.failed === true || !hasUnpersistedJoin(state, code)) return false;
  return pendingJoin.firstGen < gen || (synthGen !== undefined && synthGen <= gen);
}

/** Return true if a queued write op has been superseded and should be skipped. */
export function shouldSkipWriteOp(
  state: RecentRoomsSyncState,
  op: RecentRoomWriteOp,
  gen: number,
  removedGen: number | undefined,
  disabled: boolean,
  clearAllGen: number,
): boolean {
  if (disabled || gen < clearAllGen) return true;
  if (removedGen !== undefined && removedGen > gen) return true;
  if (op.kind === "join") return (state.persistedJoinGen.get(op.code) ?? 0) >= gen;
  if ((state.lastExternalDeleteGen.get(op.code) ?? 0) >= gen) return true;
  return (state.persistedFieldGen.get(op.code)?.[op.field] ?? 0) > gen;
}

/** Flush any unpersisted removal for `code` up to `removedGen` before executing a newer write op. */
export function flushPendingRemovalForWrite(
  storage: StorageLike | null,
  state: RecentRoomsSyncState,
  code: string,
  removedGen: number | undefined,
  persistedClearAllGen: number,
  now: number,
): boolean {
  if (
    removedGen === undefined ||
    removedGen <= (state.persistedRemovalGen.get(code) ?? 0) ||
    removedGen <= persistedClearAllGen
  ) {
    return true;
  }
  if (!removePersistedRecentRoom(storage, code, now)) return false;
  state.persistedRemovalGen.set(code, removedGen);
  return true;
}

/** Execute a queued join or field patch against `storage` while preserving newer cross-tab state. */
export function executeRecentRoomWriteOp(
  storage: StorageLike | null | undefined,
  state: RecentRoomsSyncState,
  op: RecentRoomWriteOp,
  gen: number,
  now: number,
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomPersistResult {
  if (op.kind === "join") return persistJoinOp(storage, state, op, gen, now);
  const loaded = tryLoadRecentRooms(storage, now);
  if (!loaded.ok) return "failed";
  const pendingJoin = state.pendingJoins.get(op.code);
  const synthGen = state.pendingSynthPromotions.get(op.code);
  if (
    isPreDeleteSynthPatch(state, op.code, gen, pendingJoin, synthGen) &&
    !hasLiveCreatorHostRoom(storage, op.code, now, hasSavedCreatorHostFor)
  ) {
    return "missing-on-disk";
  }
  const hasPendingJoin = shouldUsePendingJoinForPatch(state, op.code, gen, pendingJoin, synthGen);
  const nextEntries = planPatchPersistence(
    loaded.entries,
    op,
    gen,
    pendingJoin,
    hasPendingJoin,
    state.persistedFieldGen.get(op.code),
    pendingJoin ? afterCodesForJoin(state, op.code, pendingJoin.gen) : [],
  );
  if (!nextEntries) {
    return persistSynthPatch(storage, state, loaded.entries, op, gen, now, hasSavedCreatorHostFor);
  }
  if (!writePersistedRecentRooms(storage, nextEntries)) return "failed";
  if (hasPendingJoin && pendingJoin) {
    markMaterializedPendingJoin(state, pendingJoin);
  } else if (synthGen !== undefined) {
    state.pendingSynthPromotions.delete(op.code);
    state.persistedJoinGen.set(op.code, Math.max(state.persistedJoinGen.get(op.code) ?? 0, synthGen));
  }
  markPersistedField(state, op.code, op.field, gen);
  return "ok";
}

function rebuildPendingJoinEntry(
  pendingJoin: RecentRoomJoinOp & { gen: number },
  persistedEntry: RecentRoomEntry | undefined,
  patches: PendingPatchMap | undefined,
  fieldGens: PersistedFieldGens | undefined,
): RecentRoomEntry {
  let entry = buildMaterializedJoinEntry(pendingJoin, persistedEntry, fieldGens);
  if (patches) {
    for (const field of RECENT_ROOM_FIELDS) {
      const patch = patches[field];
      if (patch && shouldApplyPatchOverJoin(patch.op, patch.gen, pendingJoin, fieldGens)) {
        entry = applyPatchToEntry(entry, patch.op);
      }
    }
  }
  return entry;
}

function rebuildSynthEntry(code: string, updatedAt: number, patches: PendingPatchMap | undefined): RecentRoomEntry {
  let entry: RecentRoomEntry = { code, role: "host", lastJoinedAt: updatedAt, peerNames: [] };
  if (patches) {
    for (const field of RECENT_ROOM_FIELDS) {
      const patch = patches[field];
      if (patch) entry = applyPatchToEntry(entry, patch.op);
    }
  }
  return entry;
}

function pruneStaleSynthPromotions(
  state: RecentRoomsSyncState,
  persistedByCode: ReadonlyMap<string, RecentRoomEntry>,
  hostUpdatedByCode: ReadonlyMap<string, number>,
  persistedOk: boolean,
  hasSavedCreatorHostFor: (code: string) => boolean,
): void {
  if (!persistedOk) return;
  for (const [code, synthGen] of state.pendingSynthPromotions) {
    if (state.pendingJoins.has(code) || persistedByCode.has(code)) continue;
    if (hostUpdatedByCode.has(code) && hasSavedCreatorHostFor(code)) continue;
    let maxGen = synthGen;
    const patches = state.pendingPatches.get(code);
    if (patches) {
      for (const field of RECENT_ROOM_FIELDS) {
        const pGen = patches[field]?.gen ?? 0;
        if (pGen > maxGen) maxGen = pGen;
      }
    }
    clearPendingStateOnExternalDelete(state, code, maxGen);
    rollbackLastJoinGen(state, code, maxGen);
  }
}

function collectPendingRoomEntries(
  rooms: readonly RecentRoomEntry[],
  state: RecentRoomsSyncState,
  persistedByCode: ReadonlyMap<string, RecentRoomEntry>,
  hostUpdatedByCode: ReadonlyMap<string, number>,
  clearAllGen: number,
  persistedClearAllGen: number,
  hasSavedCreatorHostFor: (code: string) => boolean,
): { inPlace: Map<string, PendingFieldOverlay>; promoted: RecentRoomEntry[] } {
  const inPlace = new Map<string, PendingFieldOverlay>();
  const promoted: RecentRoomEntry[] = [];
  for (const entry of rooms) {
    if (
      isCodeLocallyRemoved(state, entry.code, persistedClearAllGen) ||
      (state.lastWriteGen.get(entry.code) ?? 0) <= clearAllGen
    ) {
      continue;
    }
    const pendingJoin = state.pendingJoins.get(entry.code);
    const persistedEntry = persistedByCode.get(entry.code);
    const patches = state.pendingPatches.get(entry.code);
    if (pendingJoin && hasUnpersistedJoin(state, entry.code)) {
      promoted.push(rebuildPendingJoinEntry(pendingJoin, persistedEntry, patches, state.persistedFieldGen.get(entry.code)));
      continue;
    }
    const hostUpdatedAt = hostUpdatedByCode.get(entry.code);
    if (
      !persistedEntry &&
      state.pendingSynthPromotions.has(entry.code) &&
      hasUnpersistedJoin(state, entry.code) &&
      hostUpdatedAt !== undefined &&
      hasSavedCreatorHostFor(entry.code)
    ) {
      promoted.push(rebuildSynthEntry(entry.code, hostUpdatedAt, patches));
      continue;
    }
    if (!state.synthesizedCodes.has(entry.code)) {
      const overlay = buildFieldOverlayFromPatches(patches);
      if (overlay) inPlace.set(entry.code, overlay);
    }
  }
  return { inPlace, promoted };
}

/** Merge persisted `recent-rooms`, pending in-tab writes, and legacy `host-rooms` for `syncFromStorage`. */
export function buildMergedRecentRoomsView(
  storage: StorageLike | null,
  state: RecentRoomsSyncState,
  rooms: readonly RecentRoomEntry[],
  clearAllGen: number,
  persistedClearAllGen: number,
  now: number,
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomEntry[] {
  const persisted = tryLoadRecentRooms(storage, now);
  const hostRooms = listPersistedHostRooms(storage, now);
  const persistedByCode = new Map(persisted.entries.map((entry) => [entry.code, entry]));
  const hostUpdatedByCode = new Map(hostRooms.map((hr) => [hr.code, hr.updatedAt]));
  pruneStaleSynthPromotions(state, persistedByCode, hostUpdatedByCode, persisted.ok, hasSavedCreatorHostFor);
  const { inPlace, promoted } = collectPendingRoomEntries(
    rooms,
    state,
    persistedByCode,
    hostUpdatedByCode,
    clearAllGen,
    persistedClearAllGen,
    hasSavedCreatorHostFor,
  );
  const merged = mergePendingRecentRooms(
    persisted.entries,
    inPlace,
    promoted,
    (code) => isCodeLocallyRemoved(state, code, persistedClearAllGen),
    (entry) => afterCodesForJoin(state, entry.code, state.lastJoinGen.get(entry.code) ?? 0),
    (code) => state.synthesizedCodes.delete(code),
  );
  return mergeSynthesizedHostRooms(
    merged,
    hostRooms,
    (code) => !isCodeLocallyRemoved(state, code, persistedClearAllGen) && hasSavedCreatorHostFor(code),
    (code) => state.synthesizedCodes.add(code),
  );
}

/** Return true if any non-pending local room deletion has not yet been flushed to disk. */
export function hasPendingRecoveryRemovals(state: RecentRoomsSyncState, persistedClearAllGen: number): boolean {
  for (const code of state.lastRemovalGen.keys()) {
    if (!state.pendingRemovals.has(code) && isCodeLocallyRemoved(state, code, persistedClearAllGen)) return true;
  }
  return false;
}

/** Flush any unpersisted local room deletions to disk once storage recovers. */
export function flushPendingRemovalsForRecovery(
  storage: StorageLike | null,
  state: RecentRoomsSyncState,
  persistedClearAllGen: number,
  now: number,
): boolean {
  let changed = false;
  for (const [code, rGen] of state.lastRemovalGen) {
    if (state.pendingRemovals.has(code)) continue;
    const satisfiedBy = Math.max(
      state.persistedRemovalGen.get(code) ?? 0,
      persistedClearAllGen,
      state.lastJoinGen.get(code) ?? 0,
    );
    if (rGen > satisfiedBy && removePersistedRecentRoom(storage, code, now)) {
      state.persistedRemovalGen.set(code, rGen);
      changed = true;
    }
  }
  return changed;
}
