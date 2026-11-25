import { isValidRoomCode } from "@shared/protocol";
import { listPersistedHostRooms, type LockManagerLike, type StorageLike } from "../host-tokens";
import {
  clearAllPersistedRecentRooms,
  hasStaleRecentRooms,
  pruneExpiredRecentRooms,
  runWithRecentRoomsLock,
  setRecentRoomsDisabled,
  tryIsRecentRoomsDisabled,
  tryLoadRecentRooms,
  writePersistedRecentRooms,
} from "../recent-rooms";
import {
  filterRecentRooms,
  mergeSynthesizedHostRooms,
  patchEntryInList,
  removeEntryFromList,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  upsertJoinEntry,
  type RecentRoomEntry,
  type RecentRoomPatchOp,
  type RecentRoomRole,
} from "../recent-rooms-model";

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
 * Controller for recent rooms state, legacy `host-rooms` synthesis,
 * serialized Web Lock read-modify-write persistence, and search/editing UI state.
 */
export class RecentRoomsController {
  private readonly env: RecentRoomsEnvironment;
  private rooms: RecentRoomEntry[] = [];
  private disabled = false;
  private searchQuery = "";
  private editingCode: string | null = null;
  private lockChain: Promise<void> = Promise.resolve();
  private pendingMutations = 0;

  constructor(env: RecentRoomsEnvironment) {
    this.env = env;
    this.syncFromStorage(false);
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  private normalizeUiState(): void {
    if (this.editingCode !== null && !this.rooms.some((r) => r.code === this.editingCode)) this.editingCode = null;
    if (this.rooms.length < 3) this.searchQuery = "";
  }

  private runWithoutSync(fn: () => void): void {
    this.pendingMutations++;
    try {
      fn();
    } finally {
      this.pendingMutations--;
    }
  }

  private refreshFromDisk(storage: StorageLike | null, now: number, loadedEntries?: readonly RecentRoomEntry[]): void {
    if (this.disabled) {
      this.rooms = [];
      this.normalizeUiState();
      return;
    }
    const baseEntries = loadedEntries ?? (() => {
      const loaded = tryLoadRecentRooms(storage, now);
      return loaded.ok ? loaded.entries : this.rooms;
    })();
    const hostRooms = listPersistedHostRooms(storage, now);
    this.rooms = mergeSynthesizedHostRooms(baseEntries, hostRooms, (code) => this.env.hasSavedCreatorHostFor(code));
    this.normalizeUiState();
  }

  private enqueueLocked(task: () => void): void {
    const locks = this.env.getLocks();
    if (!locks) {
      task();
      return;
    }
    this.pendingMutations++;
    this.lockChain = this.lockChain.then(() =>
      runWithRecentRoomsLock(locks, () => {
        try {
          task();
        } finally {
          this.pendingMutations--;
        }
      }),
    );
    this.env.runBackground(this.lockChain);
  }

  private stateSnapshot(): string {
    return JSON.stringify([this.disabled, this.searchQuery, this.editingCode, this.rooms]);
  }

  private applyLockedMutation(mutate: (storage: StorageLike | null, now: number) => void): void {
    const hasAsyncLock = this.env.getLocks() !== null;
    this.enqueueLocked(() => {
      const prev = hasAsyncLock ? this.stateSnapshot() : null;
      const storage = this.env.getLocalStorage();
      mutate(storage, this.now());
      if (!hasAsyncLock || this.stateSnapshot() !== prev) {
        this.env.onChange();
      }
    });
  }

  private isExternallyDisabled(storage: StorageLike | null): boolean {
    const disabledState = tryIsRecentRoomsDisabled(storage);
    if (!disabledState.ok) return true;
    if (!disabledState.disabled) return false;
    this.disabled = true;
    clearAllPersistedRecentRooms(storage);
    this.rooms = [];
    this.normalizeUiState();
    return true;
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
    const role: RecentRoomRole = this.env.hasSavedCreatorHostFor(code) ? "host" : "guest";
    const cleanPw = sanitizePassword(params.password);
    const cleanPeers = sanitizePeerNames(params.peerNames);
    const op = {
      code,
      role,
      lastJoinedAt: now,
      ...(cleanPw !== undefined ? { password: cleanPw } : {}),
      ...(cleanPeers.length > 0 ? { peerNames: cleanPeers } : {}),
    };

    const optimistic = upsertJoinEntry(this.rooms, op, now);
    if (optimistic) {
      this.rooms = optimistic;
      this.normalizeUiState();
      if (this.env.getLocks()) this.env.onChange();
    }

    this.applyLockedMutation((storage, lockNow) => {
      if (this.isExternallyDisabled(storage)) return;
      const loaded = tryLoadRecentRooms(storage, lockNow);
      if (!loaded.ok) return;
      const next = upsertJoinEntry(loaded.entries, op, lockNow);
      if (!next || !writePersistedRecentRooms(storage, next)) {
        this.refreshFromDisk(storage, lockNow, loaded.entries);
        return;
      }
      this.refreshFromDisk(storage, lockNow, next);
    });
  }

  private applyPatch(op: RecentRoomPatchOp, forceNotify: boolean = false): void {
    const optimistic = patchEntryInList(this.rooms, op, this.now(), [], (c) => this.env.hasSavedCreatorHostFor(c));
    if (optimistic) {
      this.rooms = optimistic;
      this.normalizeUiState();
    }
    if ((optimistic || forceNotify) && this.env.getLocks()) this.env.onChange();

    this.applyLockedMutation((storage, now) => {
      if (this.isExternallyDisabled(storage)) return;
      const loaded = tryLoadRecentRooms(storage, now);
      if (!loaded.ok) return;
      const hostRooms = listPersistedHostRooms(storage, now);
      const next = patchEntryInList(loaded.entries, op, now, hostRooms, (c) => this.env.hasSavedCreatorHostFor(c));
      if (!next || !writePersistedRecentRooms(storage, next)) {
        this.refreshFromDisk(storage, now, loaded.entries);
        return;
      }
      this.refreshFromDisk(storage, now, next);
    });
  }

  updatePassword(code: string, password: string | undefined, locked: boolean): void {
    const upper = code.trim().toUpperCase();
    const clean = sanitizePassword(password);
    if (this.disabled || locked || clean === undefined || !isValidRoomCode(upper)) return;
    const existing = this.rooms.find((r) => r.code === upper);
    if (existing?.password === clean) return;
    this.applyPatch({ kind: "patch", code: upper, field: "password", password: clean });
  }

  updatePeers(code: string, peerNames: readonly string[]): void {
    const upper = code.trim().toUpperCase();
    if (this.disabled || !isValidRoomCode(upper)) return;
    const sanitized = sanitizePeerNames(peerNames);
    if (sanitized.length === 0) return;
    const existing = this.rooms.find((r) => r.code === upper);
    if (existing && sameStringArray(existing.peerNames, sanitized)) return;
    this.applyPatch({ kind: "patch", code: upper, field: "peerNames", peerNames: sanitized });
  }

  rename(code: string, label: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    this.editingCode = null;
    if (this.disabled || !this.rooms.some((r) => r.code === upper)) {
      this.env.onChange();
      return;
    }
    const nextLabel = sanitizeRecentRoomLabel(label);
    this.applyPatch(
      {
        kind: "patch",
        code: upper,
        field: "label",
        ...(nextLabel !== undefined ? { label: nextLabel } : {}),
      },
      true,
    );
  }

  private removeEntry(upper: string, demoteIfPassworded: boolean, cleanupToken?: () => void): boolean {
    const existed = this.rooms.some((r) => r.code === upper);
    const optimistic = removeEntryFromList(this.rooms, upper, demoteIfPassworded);
    if (optimistic) {
      this.rooms = optimistic;
      this.normalizeUiState();
    }
    if (cleanupToken) this.runWithoutSync(cleanupToken);
    this.env.onChange();

    this.applyLockedMutation((storage, now) => {
      if (this.isExternallyDisabled(storage)) return;
      const loaded = tryLoadRecentRooms(storage, now);
      if (!loaded.ok) return;
      const next = removeEntryFromList(loaded.entries, upper, demoteIfPassworded);
      if (next && !writePersistedRecentRooms(storage, next)) return;
      this.refreshFromDisk(storage, now, next ?? loaded.entries);
    });
    return existed;
  }

  remove(code: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    this.removeEntry(upper, false, () => this.env.onRemoveHostToken(upper));
  }

  handleCreatorHostForgotten(code: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper) || !this.rooms.some((r) => r.code === upper)) return;
    this.removeEntry(upper, true);
  }

  handleFatalError(code: string, errCode: string, expectedHostToken?: string): boolean {
    if (errCode !== "kicked" && errCode !== "bad-password") return false;
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return false;
    return this.removeEntry(
      upper,
      false,
      expectedHostToken !== undefined ? () => this.env.onRemoveHostToken(upper, expectedHostToken) : undefined,
    );
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.searchQuery = "";
    this.editingCode = null;
    if (disabled) {
      this.rooms = [];
      this.runWithoutSync(() => this.env.onForgetAllHostTokens());
    }
    this.env.onChange();

    this.applyLockedMutation((storage, now) => {
      if (!setRecentRoomsDisabled(storage, disabled)) return;
      this.disabled = disabled;
      this.searchQuery = "";
      this.editingCode = null;
      if (disabled) {
        clearAllPersistedRecentRooms(storage);
        this.rooms = [];
      } else {
        this.refreshFromDisk(storage, now);
      }
    });
  }

  clearAll(): void {
    this.rooms = [];
    this.searchQuery = "";
    this.editingCode = null;
    this.runWithoutSync(() => this.env.onForgetAllHostTokens());
    this.env.onChange();

    this.applyLockedMutation((storage) => {
      clearAllPersistedRecentRooms(storage);
      this.rooms = [];
      this.isExternallyDisabled(storage);
    });
  }

  syncFromStorage(notify: boolean = true): void {
    if (this.pendingMutations > 0) return;
    const storage = this.env.getLocalStorage();
    const now = this.now();
    const disabledState = tryIsRecentRoomsDisabled(storage);
    if (disabledState.ok) this.disabled = disabledState.disabled;
    this.refreshFromDisk(storage, now);
    if (!this.disabled && hasStaleRecentRooms(storage, now)) {
      this.applyLockedMutation((lockedStorage, lockNow) => {
        if (this.isExternallyDisabled(lockedStorage)) return;
        pruneExpiredRecentRooms(lockedStorage, lockNow);
        this.refreshFromDisk(lockedStorage, lockNow);
      });
    }
    if (notify) this.env.onChange();
  }
}
