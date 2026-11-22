import { isValidRoomCode } from "@shared/protocol";
import type { LockManagerLike, StorageLike } from "../host-tokens";
import {
  clearAllPersistedRecentRooms,
  hasStaleRecentRooms,
  isRecentRoomsDisabled,
  isRecentRoomsKeyAbsent,
  pruneExpiredRecentRooms,
  removePersistedRecentRoom,
  runWithRecentRoomsLock,
  setRecentRoomsDisabled,
} from "../recent-rooms";
import {
  buildJoinedRoomEntry,
  clearPendingStateOnExternalDelete,
  createRecentRoomsSyncState,
  filterRecentRooms,
  isCodeLocallyRemoved,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  setPendingPatchInMap,
  sortAndBoundEntries,
  type RecentRoomEntry,
  type RecentRoomJoinOp,
  type RecentRoomPatchOp,
  type RecentRoomWriteOp,
} from "../recent-rooms-model";
import {
  buildMergedRecentRoomsView,
  clearCodeFromSyncMaps,
  dropFailedWriteOp,
  executeRecentRoomWriteOp,
  flushPendingRemovalForWrite,
  flushPendingRemovalsForRecovery,
  hasPendingRecoveryRemovals,
  pruneFailedPendingJoins,
  resetRecentRoomsSyncMaps,
  shouldSkipWriteOp,
} from "../recent-rooms-sync";

export interface RecentRoomsEnvironment {
  getLocalStorage: () => StorageLike | null;
  getLocks: () => LockManagerLike | null;
  runBackground: (task: Promise<unknown>) => void;
  hasSavedCreatorHostFor: (code: string) => boolean;
  onRemoveHostToken: (code: string, onlyIfMatching?: string) => void;
  onForgetAllHostTokens: () => void;
  onChange: () => void;
  now?: () => number;
}

export interface RecordJoinParams {
  code: string;
  password?: string | undefined;
  peerNames?: readonly string[] | undefined;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Pure, DOM-free controller for recent rooms state, legacy `host-rooms` synthesis,
 * Web Lock race guards, search/filter, inline rename, and error cleanup.
 */
export class RecentRoomsController {
  private readonly env: RecentRoomsEnvironment;
  private readonly syncState = createRecentRoomsSyncState();
  private rooms: RecentRoomEntry[] = [];
  private disabled = false;
  private searchQuery = "";
  private editingCode: string | null = null;
  private mutationGen = 0;
  private disabledGen = 0;
  private persistedDisabledGen = 0;
  private clearAllGen = 0;
  private persistedClearAllGen = 0;
  private writeCutoffGen = 0;
  private pendingClearAll = 0;
  private pendingDisabledSync = 0;
  private pendingPurge = false;
  private pendingRecoverySync = false;

  constructor(env: RecentRoomsEnvironment) {
    this.env = env;
    this.syncFromStorage(false);
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  private clearPersistedIfCurrent(storage: StorageLike | null, gen: number): boolean {
    if (this.clearAllGen !== gen || this.persistedClearAllGen >= gen) return false;
    if (!clearAllPersistedRecentRooms(storage)) return false;
    this.persistedClearAllGen = gen;
    return true;
  }

  private handleFailedWriteOp(op: RecentRoomWriteOp, gen: number): void {
    if (dropFailedWriteOp(this.syncState, op, gen)) this.syncFromStorage(true);
  }

  private applyExternalOptOut(storage: StorageLike | null): void {
    const gen = ++this.mutationGen;
    this.writeCutoffGen = gen;
    if (this.persistedClearAllGen === this.clearAllGen || isRecentRoomsKeyAbsent(storage)) {
      this.clearAllGen = gen;
      this.persistedClearAllGen = gen;
    }
    resetRecentRoomsSyncMaps(this.syncState);
    this.disabled = true;
    this.persistedDisabledGen = this.disabledGen;
  }

  private ensureWritePreconditions(
    storage: StorageLike | null,
    op: RecentRoomWriteOp,
    gen: number,
    removedGen: number | undefined,
    now: number,
  ): boolean {
    if (this.clearAllGen > this.persistedClearAllGen) {
      if (!clearAllPersistedRecentRooms(storage)) {
        this.handleFailedWriteOp(op, gen);
        return false;
      }
      this.persistedClearAllGen = this.clearAllGen;
    }
    if (!this.disabled && this.disabledGen > this.persistedDisabledGen) {
      if (!setRecentRoomsDisabled(storage, false)) {
        this.handleFailedWriteOp(op, gen);
        return false;
      }
      this.persistedDisabledGen = this.disabledGen;
    }
    if (isRecentRoomsDisabled(storage)) {
      this.applyExternalOptOut(storage);
      this.syncFromStorage(true);
      return false;
    }
    if (!flushPendingRemovalForWrite(storage, this.syncState, op.code, removedGen, this.persistedClearAllGen, now)) {
      this.handleFailedWriteOp(op, gen);
      return false;
    }
    return true;
  }

  private enqueueWrite(gen: number, op: RecentRoomWriteOp): void {
    const code = op.code;
    this.syncState.lastWriteGen.set(code, gen);
    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        const removedGen = this.syncState.lastRemovalGen.get(code);
        if (shouldSkipWriteOp(this.syncState, op, gen, removedGen, this.disabled, this.writeCutoffGen)) return;
        const storage = this.env.getLocalStorage();
        const now = this.now();
        if (!this.ensureWritePreconditions(storage, op, gen, removedGen, now)) return;
        const res = executeRecentRoomWriteOp(storage, this.syncState, op, gen, now, (c) =>
          this.env.hasSavedCreatorHostFor(c),
        );
        if (res === "missing-on-disk") {
          clearPendingStateOnExternalDelete(this.syncState, code, gen);
          this.syncFromStorage(true);
        } else if (res === "failed") {
          this.handleFailedWriteOp(op, gen);
        }
      }),
    );
  }

  private normalizeUiState(): void {
    if (this.editingCode !== null && !this.rooms.some((r) => r.code === this.editingCode)) this.editingCode = null;
    if (this.rooms.length < 3) this.searchQuery = "";
  }

  private applyMetadataUpdate(upper: string, updated: RecentRoomEntry, gen: number): void {
    if (this.syncState.synthesizedCodes.delete(upper)) {
      this.syncState.lastJoinGen.set(upper, gen);
      this.syncState.pendingSynthPromotions.set(upper, gen);
      this.rooms = sortAndBoundEntries([updated, ...this.rooms.filter((r) => r.code !== upper)]);
      return;
    }
    this.rooms = this.rooms.map((r) => (r.code === upper ? updated : r));
  }

  private loadMergedRooms(storage: StorageLike | null, now: number): RecentRoomEntry[] {
    pruneFailedPendingJoins(this.syncState);
    if (this.disabled) {
      this.syncState.synthesizedCodes.clear();
      return [];
    }
    if (this.persistedClearAllGen < this.clearAllGen) {
      return sortAndBoundEntries(
        this.rooms.filter(
          (entry) =>
            !isCodeLocallyRemoved(this.syncState, entry.code, this.persistedClearAllGen) &&
            (this.syncState.lastWriteGen.get(entry.code) ?? 0) > this.writeCutoffGen,
        ),
      );
    }
    return buildMergedRecentRoomsView(
      storage,
      this.syncState,
      this.rooms,
      this.writeCutoffGen,
      this.persistedClearAllGen,
      now,
      (c) => this.env.hasSavedCreatorHostFor(c),
    );
  }

  private maybeScheduleExpiredPurge(storage: StorageLike | null, now: number): void {
    if (
      this.pendingPurge ||
      this.disabled ||
      this.pendingClearAll > 0 ||
      this.persistedClearAllGen < this.clearAllGen ||
      !hasStaleRecentRooms(storage, now)
    ) {
      return;
    }
    this.pendingPurge = true;
    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        try {
          if (this.disabled || this.clearAllGen > this.persistedClearAllGen) return;
          pruneExpiredRecentRooms(this.env.getLocalStorage(), this.now());
        } finally {
          this.pendingPurge = false;
        }
      }),
    );
  }

  getRooms(): readonly RecentRoomEntry[] {
    return [...this.rooms];
  }

  getFilteredRooms(): RecentRoomEntry[] {
    return filterRecentRooms(this.rooms, this.searchQuery);
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  setSearchQuery(query: string): void {
    if (this.searchQuery === query) return;
    this.searchQuery = query;
    this.env.onChange();
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  getEditingCode(): string | null {
    return this.editingCode;
  }

  setEditingCode(code: string | null): void {
    const upper = code !== null ? code.trim().toUpperCase() : null;
    const next = upper !== null && this.rooms.some((r) => r.code === upper) ? upper : null;
    if (this.editingCode === next) return;
    this.editingCode = next;
    this.env.onChange();
  }

  recordJoin(params: RecordJoinParams): void {
    const code = params.code.trim().toUpperCase();
    if (this.disabled || !isValidRoomCode(code)) return;

    const now = this.now();
    const role = this.env.hasSavedCreatorHostFor(code) ? "host" : "guest";
    this.syncState.pendingRemovals.delete(code);
    this.syncState.synthesizedCodes.delete(code);
    const gen = ++this.mutationGen;
    this.syncState.lastJoinGen.set(code, gen);

    const existing = this.rooms.find((r) => r.code === code);
    const nextEntry = buildJoinedRoomEntry(code, role, now, existing, params.password, params.peerNames);
    this.rooms = sortAndBoundEntries([nextEntry, ...this.rooms.filter((r) => r.code !== code)]);
    this.normalizeUiState();

    const cleanPw = sanitizePassword(params.password);
    const cleanPeers = sanitizePeerNames(params.peerNames);
    const op: RecentRoomJoinOp = {
      kind: "join",
      code,
      role,
      lastJoinedAt: now,
      ...(cleanPw !== undefined ? { password: cleanPw } : {}),
      ...(cleanPeers.length > 0 ? { peerNames: cleanPeers } : {}),
    };
    const firstGen = this.syncState.pendingJoins.get(code)?.firstGen ?? gen;
    this.syncState.pendingJoins.set(code, { ...op, gen, firstGen });
    this.enqueueWrite(gen, op);
    this.env.onChange();
  }

  updatePassword(code: string, password: string | undefined, locked: boolean): void {
    const upper = code.trim().toUpperCase();
    const clean = sanitizePassword(password);
    if (locked || clean === undefined || !isValidRoomCode(upper)) return;

    const existing = this.rooms.find((r) => r.code === upper);
    if (!existing || existing.password === clean) return;

    const updated: RecentRoomEntry = { ...existing, password: clean };
    const gen = ++this.mutationGen;
    this.applyMetadataUpdate(upper, updated, gen);
    const op: Extract<RecentRoomPatchOp, { field: "password" }> = {
      kind: "patch",
      code: upper,
      field: "password",
      password: clean,
    };
    setPendingPatchInMap(this.syncState.pendingPatches, upper, gen, op);
    this.enqueueWrite(gen, op);
    this.env.onChange();
  }

  updatePeers(code: string, peerNames: readonly string[]): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    const sanitized = sanitizePeerNames(peerNames);
    if (sanitized.length === 0) return;

    const existing = this.rooms.find((r) => r.code === upper);
    if (!existing || sameStringArray(existing.peerNames, sanitized)) return;

    const updated: RecentRoomEntry = { ...existing, peerNames: sanitized };
    const gen = ++this.mutationGen;
    this.applyMetadataUpdate(upper, updated, gen);
    const op: Extract<RecentRoomPatchOp, { field: "peerNames" }> = {
      kind: "patch",
      code: upper,
      field: "peerNames",
      peerNames: sanitized,
    };
    setPendingPatchInMap(this.syncState.pendingPatches, upper, gen, op);
    this.enqueueWrite(gen, op);
    this.env.onChange();
  }

  rename(code: string, label: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;

    const existing = this.rooms.find((r) => r.code === upper);
    this.editingCode = null;
    if (!existing) {
      this.env.onChange();
      return;
    }

    const nextLabel = sanitizeRecentRoomLabel(label);
    const { label: _prevLabel, ...withoutLabel } = existing;
    const updated: RecentRoomEntry = nextLabel !== undefined ? { ...withoutLabel, label: nextLabel } : withoutLabel;
    const gen = ++this.mutationGen;
    this.applyMetadataUpdate(upper, updated, gen);
    const op: Extract<RecentRoomPatchOp, { field: "label" }> = {
      kind: "patch",
      code: upper,
      field: "label",
      ...(nextLabel !== undefined ? { label: nextLabel } : { clearLabel: true }),
    };
    setPendingPatchInMap(this.syncState.pendingPatches, upper, gen, op);
    this.enqueueWrite(gen, op);
    this.env.onChange();
  }

  private removeFromRecentsOnly(upper: string): boolean {
    const existed = this.rooms.some((r) => r.code === upper);
    const gen = ++this.mutationGen;
    this.syncState.lastRemovalGen.set(upper, gen);
    this.syncState.pendingRemovals.set(upper, gen);
    clearCodeFromSyncMaps(this.syncState, upper);
    this.rooms = this.rooms.filter((r) => r.code !== upper);
    this.normalizeUiState();

    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        try {
          if (
            (this.syncState.persistedRemovalGen.get(upper) ?? 0) < gen &&
            this.persistedClearAllGen < gen &&
            (this.syncState.lastJoinGen.get(upper) ?? 0) < gen
          ) {
            if (removePersistedRecentRoom(this.env.getLocalStorage(), upper, this.now())) {
              this.syncState.persistedRemovalGen.set(upper, gen);
            }
          }
        } finally {
          if (this.syncState.pendingRemovals.get(upper) === gen) this.syncState.pendingRemovals.delete(upper);
        }
      }),
    );
    return existed;
  }

  remove(code: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    this.removeFromRecentsOnly(upper);
    this.env.onRemoveHostToken(upper);
    this.env.onChange();
  }

  handleCreatorHostForgotten(code: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    const existing = this.rooms.find((r) => r.code === upper);
    if (!existing) return;

    if (existing.password !== undefined) {
      const updated: RecentRoomEntry = { ...existing, role: "guest" };
      const gen = ++this.mutationGen;
      this.applyMetadataUpdate(upper, updated, gen);
      const op: Extract<RecentRoomPatchOp, { field: "role" }> = {
        kind: "patch",
        code: upper,
        field: "role",
        role: "guest",
      };
      setPendingPatchInMap(this.syncState.pendingPatches, upper, gen, op);
      this.enqueueWrite(gen, op);
    } else {
      this.removeFromRecentsOnly(upper);
    }
    this.normalizeUiState();
    this.env.onChange();
  }

  handleFatalError(code: string, errCode: string, expectedHostToken?: string): boolean {
    if (errCode !== "kicked" && errCode !== "bad-password") return false;
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return false;
    const existed = this.removeFromRecentsOnly(upper);
    if (expectedHostToken !== undefined) this.env.onRemoveHostToken(upper, expectedHostToken);
    this.env.onChange();
    return existed;
  }

  private beginClearAll(): number {
    const gen = ++this.mutationGen;
    this.clearAllGen = gen;
    this.writeCutoffGen = gen;
    this.pendingClearAll++;
    resetRecentRoomsSyncMaps(this.syncState);
    this.rooms = [];
    this.searchQuery = "";
    this.editingCode = null;
    this.env.onForgetAllHostTokens();
    return gen;
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.searchQuery = "";
    this.editingCode = null;
    this.pendingDisabledSync++;
    const dGen = ++this.disabledGen;
    let clearGen: number | undefined;
    if (disabled) {
      clearGen = this.beginClearAll();
    } else {
      this.rooms = this.loadMergedRooms(this.env.getLocalStorage(), this.now());
      this.normalizeUiState();
    }

    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        try {
          const storage = this.env.getLocalStorage();
          if (this.disabledGen === dGen && this.persistedDisabledGen < dGen && setRecentRoomsDisabled(storage, disabled)) {
            this.persistedDisabledGen = dGen;
          }
          if (clearGen !== undefined) this.clearPersistedIfCurrent(storage, clearGen);
        } finally {
          if (clearGen !== undefined) this.pendingClearAll = Math.max(0, this.pendingClearAll - 1);
          this.pendingDisabledSync = Math.max(0, this.pendingDisabledSync - 1);
        }
      }),
    );
    this.env.onChange();
  }

  clearAll(): void {
    const gen = this.beginClearAll();
    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        try {
          this.clearPersistedIfCurrent(this.env.getLocalStorage(), gen);
        } finally {
          this.pendingClearAll = Math.max(0, this.pendingClearAll - 1);
        }
      }),
    );
    this.env.onChange();
  }

  private maybeScheduleRecoverySync(): void {
    const needDis = this.pendingDisabledSync === 0 && this.persistedDisabledGen < this.disabledGen;
    const needClr = this.pendingClearAll === 0 && this.persistedClearAllGen < this.clearAllGen;
    const needRem = hasPendingRecoveryRemovals(this.syncState, this.persistedClearAllGen);
    if (this.pendingRecoverySync || (!needDis && !needClr && !needRem)) return;
    this.pendingRecoverySync = true;
    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        let changed = false;
        try {
          const storage = this.env.getLocalStorage();
          const dGen = this.disabledGen;
          if (this.pendingDisabledSync === 0 && this.persistedDisabledGen < dGen && setRecentRoomsDisabled(storage, this.disabled)) {
            if (this.disabledGen === dGen) this.persistedDisabledGen = dGen;
            if (this.disabled) clearAllPersistedRecentRooms(storage);
            changed = true;
          }
          if (this.pendingClearAll === 0) changed = this.clearPersistedIfCurrent(storage, this.clearAllGen) || changed;
          if (flushPendingRemovalsForRecovery(storage, this.syncState, this.persistedClearAllGen, this.now())) {
            changed = true;
          }
        } finally {
          this.pendingRecoverySync = false;
        }
        if (changed) this.syncFromStorage(true);
      }),
    );
  }

  syncFromStorage(notify: boolean = true): void {
    const storage = this.env.getLocalStorage();
    const now = this.now();
    if (this.persistedDisabledGen === this.disabledGen) {
      const storageDisabled = isRecentRoomsDisabled(storage);
      if (storageDisabled && !this.disabled) this.applyExternalOptOut(storage);
      else this.disabled = storageDisabled;
    }
    this.rooms = this.loadMergedRooms(storage, now);
    this.normalizeUiState();
    this.maybeScheduleRecoverySync();
    this.maybeScheduleExpiredPurge(storage, now);
    if (notify) this.env.onChange();
  }
}
