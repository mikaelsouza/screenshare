import { isValidRoomCode } from "@shared/protocol";
import { listPersistedHostRooms, type LockManagerLike, type StorageLike } from "../host-tokens";
import {
  buildJoinedRoomEntry,
  clearAllPersistedRecentRooms,
  filterRecentRooms,
  isRecentRoomsDisabled,
  loadRecentRooms,
  mergePendingRecentRooms,
  mergeSynthesizedHostRooms,
  removeRecentRoom,
  runWithRecentRoomsLock,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  setRecentRoomsDisabled,
  sortAndBoundEntries,
  upsertRecentRoom,
  type RecentRoomEntry,
} from "../recent-rooms";

export interface RecentRoomsEnvironment {
  getLocalStorage: () => StorageLike | null;
  getLocks: () => LockManagerLike | null;
  runBackground: (task: Promise<unknown>) => void;
  hasSavedCreatorHostFor: (code: string) => boolean;
  onRemoveHostToken: (code: string) => void;
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
  private readonly pendingRemovals = new Map<string, number>();
  private readonly lastRemovalGen = new Map<string, number>();
  private readonly persistedRemovalGen = new Map<string, number>();
  private readonly pendingWrites = new Map<string, number>();
  private readonly lastWriteGen = new Map<string, number>();
  private readonly persistedWriteGen = new Map<string, number>();
  private readonly lastJoinGen = new Map<string, number>();
  private readonly persistedJoinGen = new Map<string, number>();
  private readonly clearedLabelGen = new Map<string, number>();
  private readonly synthesizedCodes = new Set<string>();
  private rooms: RecentRoomEntry[] = [];
  private disabled = false;
  private searchQuery = "";
  private editingCode: string | null = null;
  private mutationGen = 0;
  private disabledGen = 0;
  private clearAllGen = 0;
  private persistedClearAllGen = 0;
  private lastCompletedWriteGen = 0;
  private pendingClearAll = 0;
  private pendingDisabledSync = 0;

  constructor(env: RecentRoomsEnvironment) {
    this.env = env;
    this.syncFromStorage(false);
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  private clearPersistedIfCurrent(storage: StorageLike | null, gen: number): void {
    if (this.clearAllGen === gen && this.persistedClearAllGen < gen && this.lastCompletedWriteGen <= gen) {
      clearAllPersistedRecentRooms(storage);
      this.persistedClearAllGen = gen;
    }
  }

  private flushPendingRemoval(code: string, removedGen: number | undefined): void {
    if (removedGen === undefined || removedGen <= (this.persistedRemovalGen.get(code) ?? 0) || removedGen <= this.persistedClearAllGen) return;
    removeRecentRoom(this.env.getLocalStorage(), code, this.now());
    this.persistedRemovalGen.set(code, removedGen);
  }

  private hasUnpersistedJoin(code: string): boolean {
    return (this.lastJoinGen.get(code) ?? 0) > (this.persistedJoinGen.get(code) ?? 0);
  }

  private afterCodesForJoin(code: string, targetGen: number): string[] {
    const after: string[] = [];
    for (const [otherCode, persistedGen] of this.persistedJoinGen) {
      if (otherCode !== code && persistedGen > targetGen) after.push(otherCode);
    }
    return after;
  }

  private sameMsPrecedingCodes(entry: RecentRoomEntry): string[] {
    const preceding: string[] = [];
    for (const item of this.rooms) {
      if (item.code === entry.code) break;
      if (item.lastJoinedAt === entry.lastJoinedAt) preceding.push(item.code);
    }
    return preceding;
  }

  private resolveWriteOrder(
    entry: RecentRoomEntry,
    preserveOrder: boolean,
    gen: number,
  ): { preserveOrder: boolean; insertAfterCodes: string[]; nextPersistedJoin?: number } {
    if (!preserveOrder || this.hasUnpersistedJoin(entry.code) || this.synthesizedCodes.has(entry.code)) {
      const targetGen =
        preserveOrder && this.hasUnpersistedJoin(entry.code) ? (this.lastJoinGen.get(entry.code) ?? 0) : gen;
      return {
        preserveOrder: false,
        insertAfterCodes: this.afterCodesForJoin(entry.code, targetGen),
        nextPersistedJoin: targetGen,
      };
    }
    return { preserveOrder: true, insertAfterCodes: this.sameMsPrecedingCodes(entry) };
  }

  private persistEntry(entry: RecentRoomEntry, preserveOrder: boolean = false, gen: number = 0): void {
    const clearGen = this.clearedLabelGen.get(entry.code);
    const shouldClearLabel = entry.label === undefined && clearGen !== undefined && gen >= clearGen;
    const order = this.resolveWriteOrder(entry, preserveOrder, gen);
    const input = {
      code: entry.code,
      role: entry.role,
      lastJoinedAt: entry.lastJoinedAt,
      ...(entry.password !== undefined ? { password: entry.password } : {}),
      ...(entry.peerNames.length > 0 ? { peerNames: entry.peerNames } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(shouldClearLabel ? { clearLabel: true } : {}),
      ...(order.preserveOrder ? { preserveOrder: true } : {}),
      ...(order.insertAfterCodes.length > 0 ? { insertAfterCodes: order.insertAfterCodes } : {}),
    };
    upsertRecentRoom(this.env.getLocalStorage(), input, this.now());
    if (order.nextPersistedJoin !== undefined) this.persistedJoinGen.set(entry.code, order.nextPersistedJoin);
    if (shouldClearLabel) this.clearedLabelGen.delete(entry.code);
    this.synthesizedCodes.delete(entry.code);
  }

  private shouldSkipWrite(code: string, gen: number, preserveOrder: boolean, removedGen: number | undefined): boolean {
    if (this.disabled || gen < this.clearAllGen) return true;
    if (removedGen !== undefined && removedGen > gen) return true;
    if ((this.persistedWriteGen.get(code) ?? 0) > gen) return true;
    return preserveOrder && this.lastWriteGen.get(code) !== gen;
  }

  private enqueueWrite(gen: number, entry: RecentRoomEntry, preserveOrder: boolean = false): void {
    const code = entry.code;
    this.lastWriteGen.set(code, gen);
    this.pendingWrites.set(code, (this.pendingWrites.get(code) ?? 0) + 1);
    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        try {
          const removedGen = this.lastRemovalGen.get(code);
          if (this.shouldSkipWrite(code, gen, preserveOrder, removedGen)) return;
          if (this.clearAllGen > this.persistedClearAllGen) {
            clearAllPersistedRecentRooms(this.env.getLocalStorage());
            this.persistedClearAllGen = this.clearAllGen;
          }
          this.flushPendingRemoval(code, removedGen);
          this.persistEntry(entry, preserveOrder, gen);
          this.persistedWriteGen.set(code, gen);
          if (gen > this.lastCompletedWriteGen) this.lastCompletedWriteGen = gen;
        } finally {
          const remaining = (this.pendingWrites.get(code) ?? 1) - 1;
          if (remaining <= 0) this.pendingWrites.delete(code);
          else this.pendingWrites.set(code, remaining);
        }
      }),
    );
  }

  private normalizeUiState(): void {
    if (this.editingCode !== null && !this.rooms.some((r) => r.code === this.editingCode)) this.editingCode = null;
    if (this.rooms.length < 3) this.searchQuery = "";
    for (const code of this.synthesizedCodes) {
      if (!this.rooms.some((r) => r.code === code)) this.synthesizedCodes.delete(code);
    }
  }

  private applyMetadataUpdate(upper: string, updated: RecentRoomEntry, gen: number): void {
    if (this.synthesizedCodes.delete(upper)) {
      this.lastJoinGen.set(upper, gen);
      this.rooms = sortAndBoundEntries([updated, ...this.rooms.filter((r) => r.code !== upper)]);
      return;
    }
    this.rooms = this.rooms.map((r) => (r.code === upper ? updated : r));
  }

  private shouldKeepPendingEntry(code: string): boolean {
    if (this.pendingRemovals.has(code)) return false;
    const writeGen = this.lastWriteGen.get(code) ?? 0;
    if (writeGen <= this.clearAllGen) return false;
    return this.pendingClearAll > 0 || this.pendingWrites.has(code);
  }

  private collectPendingEntries(): { inPlace: Map<string, RecentRoomEntry>; promoted: RecentRoomEntry[] } {
    const inPlace = new Map<string, RecentRoomEntry>();
    const promoted: RecentRoomEntry[] = [];
    for (const entry of this.rooms) {
      if (!this.shouldKeepPendingEntry(entry.code)) continue;
      if (this.hasUnpersistedJoin(entry.code) || this.synthesizedCodes.has(entry.code)) promoted.push(entry);
      else inPlace.set(entry.code, entry);
    }
    return { inPlace, promoted };
  }

  private loadMergedRooms(storage: StorageLike | null, now: number): RecentRoomEntry[] {
    if (this.disabled) {
      this.synthesizedCodes.clear();
      return [];
    }
    if (this.pendingClearAll > 0) {
      return sortAndBoundEntries(this.rooms.filter((entry) => this.shouldKeepPendingEntry(entry.code)));
    }
    const { inPlace, promoted } = this.collectPendingEntries();
    const merged = mergePendingRecentRooms(
      loadRecentRooms(storage, now),
      inPlace,
      promoted,
      (code) => this.pendingRemovals.has(code),
      (entry) => {
        const targetGen = this.hasUnpersistedJoin(entry.code)
          ? (this.lastJoinGen.get(entry.code) ?? 0)
          : (this.lastWriteGen.get(entry.code) ?? 0);
        return this.afterCodesForJoin(entry.code, targetGen);
      },
      (code) => {
        if (!this.pendingWrites.has(code) && this.hasUnpersistedJoin(code)) {
          this.lastJoinGen.delete(code);
        }
        this.synthesizedCodes.delete(code);
      },
    );
    return mergeSynthesizedHostRooms(
      merged,
      listPersistedHostRooms(storage, now),
      (code) => !this.pendingRemovals.has(code) && this.env.hasSavedCreatorHostFor(code),
      (code) => this.synthesizedCodes.add(code),
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
    this.pendingRemovals.delete(code);
    this.synthesizedCodes.delete(code);
    const gen = ++this.mutationGen;
    this.lastJoinGen.set(code, gen);

    const existing = this.rooms.find((r) => r.code === code);
    const nextEntry = buildJoinedRoomEntry(code, role, now, existing, params.password, params.peerNames);
    this.rooms = sortAndBoundEntries([nextEntry, ...this.rooms.filter((r) => r.code !== code)]);
    this.normalizeUiState();

    this.enqueueWrite(gen, nextEntry);
    this.env.onChange();
  }

  updatePassword(code: string, password: string | undefined, locked: boolean): void {
    const upper = code.trim().toUpperCase();
    const clean = sanitizePassword(password);
    if (this.disabled || locked || clean === undefined || !isValidRoomCode(upper)) return;

    const existing = this.rooms.find((r) => r.code === upper);
    if (!existing || existing.password === clean) return;

    const updated: RecentRoomEntry = { ...existing, password: clean };
    const gen = ++this.mutationGen;
    this.applyMetadataUpdate(upper, updated, gen);

    this.enqueueWrite(gen, updated, true);
    this.env.onChange();
  }

  updatePeers(code: string, peerNames: readonly string[]): void {
    const upper = code.trim().toUpperCase();
    if (this.disabled || !isValidRoomCode(upper)) return;
    const sanitized = sanitizePeerNames(peerNames);
    if (sanitized.length === 0) return;

    const existing = this.rooms.find((r) => r.code === upper);
    if (!existing || sameStringArray(existing.peerNames, sanitized)) return;

    const updated: RecentRoomEntry = { ...existing, peerNames: sanitized };
    const gen = ++this.mutationGen;
    this.applyMetadataUpdate(upper, updated, gen);

    this.enqueueWrite(gen, updated, true);
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
    if (nextLabel === undefined) this.clearedLabelGen.set(upper, gen);
    else this.clearedLabelGen.delete(upper);

    this.enqueueWrite(gen, updated, true);
    this.env.onChange();
  }

  private removeFromRecentsOnly(upper: string): boolean {
    const existed = this.rooms.some((r) => r.code === upper);
    const gen = ++this.mutationGen;
    this.lastRemovalGen.set(upper, gen);
    this.pendingRemovals.set(upper, gen);
    this.clearedLabelGen.delete(upper);
    this.lastJoinGen.delete(upper);
    this.synthesizedCodes.delete(upper);
    this.rooms = this.rooms.filter((r) => r.code !== upper);
    this.normalizeUiState();

    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => {
        try {
          if (
            this.lastRemovalGen.get(upper) === gen &&
            (this.persistedRemovalGen.get(upper) ?? 0) < gen &&
            (this.lastWriteGen.get(upper) ?? 0) <= gen &&
            this.persistedClearAllGen < gen
          ) {
            removeRecentRoom(this.env.getLocalStorage(), upper, this.now());
            this.persistedRemovalGen.set(upper, gen);
          }
        } finally {
          if (this.pendingRemovals.get(upper) === gen) this.pendingRemovals.delete(upper);
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

    if (existing.password !== undefined && existing.password.length > 0) {
      const updated: RecentRoomEntry = { ...existing, role: "guest" };
      const gen = ++this.mutationGen;
      this.applyMetadataUpdate(upper, updated, gen);
      this.enqueueWrite(gen, updated, true);
    } else {
      this.removeFromRecentsOnly(upper);
    }
    this.normalizeUiState();
    this.env.onChange();
  }

  handleFatalError(code: string, errCode: string): boolean {
    if (errCode !== "kicked" && errCode !== "bad-password") return false;
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return false;
    const existed = this.removeFromRecentsOnly(upper);
    this.env.onRemoveHostToken(upper);
    this.env.onChange();
    return existed;
  }

  private beginClearAll(): number {
    const gen = ++this.mutationGen;
    this.clearAllGen = gen;
    this.pendingClearAll++;
    this.clearedLabelGen.clear();
    this.lastJoinGen.clear();
    this.synthesizedCodes.clear();
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
          if (this.disabledGen === dGen && this.disabled === disabled) setRecentRoomsDisabled(storage, disabled);
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

  syncFromStorage(notify: boolean = true): void {
    const storage = this.env.getLocalStorage();
    if (this.pendingDisabledSync === 0) this.disabled = isRecentRoomsDisabled(storage);
    this.rooms = this.loadMergedRooms(storage, this.now());
    this.normalizeUiState();
    if (notify) this.env.onChange();
  }
}
