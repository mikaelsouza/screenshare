import { isValidRoomCode } from "@shared/protocol";
import { listPersistedHostRooms, type LockManagerLike, type StorageLike } from "../host-tokens";
import {
  clearAllPersistedRecentRooms,
  hasStaleRecentRooms,
  isRecentRoomsKeyAbsent,
  pruneExpiredRecentRooms,
  runWithRecentRoomsLock,
  setRecentRoomsDisabled,
  tryIsRecentRoomsDisabled,
  tryLoadRecentRooms,
  writePersistedRecentRooms,
} from "../recent-rooms";
import {
  applyRecentRoomOp,
  computeRecentRoomsView,
  filterRecentRooms,
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  type RecentRoomEntry,
  type RecentRoomJoinOp,
  type RecentRoomOp,
  type RecentRoomPatchOp,
  type RecentRoomsSnapshot,
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

function isDurableOp(op: RecentRoomOp): boolean {
  return op.kind === "clear-all" || op.kind === "set-disabled" || op.kind === "remove";
}

function shouldReconcileDemote(
  code: string,
  persistedEntries: readonly RecentRoomEntry[],
  memEntries: readonly RecentRoomEntry[],
): boolean {
  const onDisk = persistedEntries.some((e) => e.code === code);
  const inMemAsGuest = memEntries.some((r) => r.code === code && r.role === "guest");
  const inMem = memEntries.some((r) => r.code === code);
  return onDisk ? !inMemAsGuest : inMem;
}

function shouldReconcileRemove(
  storage: StorageLike | null,
  now: number,
  op: Extract<RecentRoomOp, { kind: "remove" }>,
  persistedEntries: readonly RecentRoomEntry[],
  memEntries: readonly RecentRoomEntry[],
  hasCreator: (code: string) => boolean,
): boolean {
  if (op.demoteIfPassworded === true && shouldReconcileDemote(op.code, persistedEntries, memEntries)) {
    return true;
  }
  return hasCreator(op.code) && listPersistedHostRooms(storage, now).some((hr) => hr.code === op.code);
}

function shouldApplyCarriedPatch(patch: RecentRoomPatchOp, joinOp: RecentRoomJoinOp): boolean {
  if (patch.field === "password" && joinOp.password !== undefined) return false;
  if (patch.field === "peerNames" && joinOp.peerNames !== undefined && joinOp.peerNames.length > 0) return false;
  return true;
}

function applyCarriedPatches(
  snapshot: RecentRoomsSnapshot,
  joinOp: RecentRoomJoinOp,
  carried: readonly RecentRoomPatchOp[] | undefined,
  now: number,
  hasSavedCreatorHostFor: (code: string) => boolean,
): RecentRoomsSnapshot {
  if (!carried || carried.length === 0) return snapshot;
  let current = snapshot;
  for (const patch of carried) {
    if (!shouldApplyCarriedPatch(patch, joinOp)) continue;
    current = applyRecentRoomOp(current, patch, now, [], hasSavedCreatorHostFor).snapshot;
  }
  return current;
}

/**
 * Pure, DOM-free controller for recent rooms state, legacy `host-rooms` synthesis,
 * single-flight FIFO persistence under Web Locks, search/filter, and error recovery.
 */
export class RecentRoomsController {
  private readonly env: RecentRoomsEnvironment;
  private rooms: RecentRoomEntry[] = [];
  private persistedRooms: RecentRoomEntry[] = [];
  private disabled = false;
  private searchQuery = "";
  private editingCode: string | null = null;
  private queue: RecentRoomOp[] = [];
  private flushing = false;
  private flushRequested = false;
  private pendingPurge = false;
  private readonly failedJoinCodes = new Set<string>();

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

  private recomputeView(storage: StorageLike | null, now: number): void {
    const loaded = tryLoadRecentRooms(storage, now);
    if (loaded.ok) {
      this.persistedRooms = loaded.entries;
    }
    const entries = [...(loaded.ok ? loaded.entries : this.persistedRooms)];
    const hostRooms = this.disabled ? [] : listPersistedHostRooms(storage, now);
    const view = computeRecentRoomsView(
      { entries, disabled: this.disabled },
      this.queue,
      now,
      hostRooms,
      (code) => this.env.hasSavedCreatorHostFor(code),
    );
    this.rooms = view.entries;
  }

  private enqueueOp(op: RecentRoomOp): void {
    this.queue.push(op);
    this.recomputeView(this.env.getLocalStorage(), this.now());
    this.normalizeUiState();
    this.scheduleFlush();
    this.env.onChange();
  }

  private scheduleFlush(): void {
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }
    if (this.queue.length === 0 && !this.pendingPurge) return;
    this.flushing = true;
    this.env.runBackground(
      runWithRecentRoomsLock(this.env.getLocks(), () => this.drainQueueUnderLock()),
    );
  }

  private applyExternalOptOut(storage: StorageLike | null): void {
    this.disabled = true;
    this.failedJoinCodes.clear();
    const keepClearAll = !isRecentRoomsKeyAbsent(storage);
    this.queue = this.queue.filter((op) => keepClearAll && op.kind === "clear-all");
    if (keepClearAll && this.queue.length === 0) {
      this.queue.push({ kind: "clear-all" });
    }
  }

  private handleMissingPatch(
    op: RecentRoomPatchOp,
    carryPatches: Map<string, RecentRoomPatchOp[]>,
  ): "ok" | "reconcile" {
    const hasJoin = this.queue.some((queued) => queued.kind === "join" && queued.code === op.code);
    if (this.failedJoinCodes.has(op.code) && hasJoin) {
      const list = carryPatches.get(op.code) ?? [];
      list.push(op);
      carryPatches.set(op.code, list);
      return "ok";
    }
    this.failedJoinCodes.delete(op.code);
    return "reconcile";
  }

  private persistEntryOp(
    storage: StorageLike | null,
    op: Exclude<RecentRoomOp, { kind: "clear-all" } | { kind: "set-disabled" }>,
    carryPatches: Map<string, RecentRoomPatchOp[]>,
  ): "ok" | "reconcile" | "storage-error" {
    const now = this.now();
    const loaded = tryLoadRecentRooms(storage, now);
    if (!loaded.ok) return "storage-error";
    this.persistedRooms = loaded.entries;
    const hostRooms = op.kind === "patch" ? listPersistedHostRooms(storage, now) : [];
    const hasCreator = (code: string): boolean => this.env.hasSavedCreatorHostFor(code);
    let outcome = applyRecentRoomOp({ entries: loaded.entries, disabled: false }, op, now, hostRooms, hasCreator);

    if (op.kind === "patch" && outcome.missing) return this.handleMissingPatch(op, carryPatches);
    if (op.kind === "join" && outcome.changed) {
      const carried = carryPatches.get(op.code);
      outcome = { ...outcome, snapshot: applyCarriedPatches(outcome.snapshot, op, carried, now, hasCreator) };
    }
    if (outcome.changed && !writePersistedRecentRooms(storage, outcome.snapshot.entries)) return "storage-error";
    this.persistedRooms = outcome.snapshot.entries;
    if (op.kind === "join") {
      carryPatches.delete(op.code);
      if (this.failedJoinCodes.delete(op.code)) return "reconcile";
    }
    if (op.kind === "remove") {
      this.failedJoinCodes.delete(op.code);
      carryPatches.delete(op.code);
      if (shouldReconcileRemove(storage, now, op, outcome.snapshot.entries, this.rooms, hasCreator)) {
        return "reconcile";
      }
    }
    return "ok";
  }

  private persistStorageOp(
    storage: StorageLike | null,
    op: RecentRoomOp,
    carryPatches: Map<string, RecentRoomPatchOp[]>,
  ): "ok" | "reconcile" | "external-opt-out" | "storage-error" {
    if (op.kind === "clear-all") {
      if (!clearAllPersistedRecentRooms(storage)) return "storage-error";
      this.persistedRooms = [];
      this.failedJoinCodes.clear();
      carryPatches.clear();
      return "ok";
    }
    if (op.kind === "set-disabled") {
      if (!setRecentRoomsDisabled(storage, op.disabled)) return "storage-error";
      if (op.disabled) {
        this.failedJoinCodes.clear();
        carryPatches.clear();
      }
      return "ok";
    }
    const disabledState = tryIsRecentRoomsDisabled(storage);
    if (!disabledState.ok) return "storage-error";
    if (disabledState.disabled) return "external-opt-out";
    return this.persistEntryOp(storage, op, carryPatches);
  }

  private abortQueueOnStorageError(
    failedOp: RecentRoomOp,
    carryPatches: ReadonlyMap<string, RecentRoomPatchOp[]>,
  ): boolean {
    const droppedPatchCodes = new Set<string>(carryPatches.keys());
    const droppedJoinCodes = new Set<string>();
    for (const op of [failedOp, ...this.queue]) {
      if (op.kind === "patch") droppedPatchCodes.add(op.code);
      else if (op.kind === "join") droppedJoinCodes.add(op.code);
    }
    for (const code of droppedPatchCodes) this.failedJoinCodes.delete(code);
    for (const code of droppedJoinCodes) {
      if (!droppedPatchCodes.has(code) && !this.persistedRooms.some((r) => r.code === code)) {
        this.failedJoinCodes.add(code);
      }
    }
    const remainingDurable = this.queue.filter(isDurableOp);
    this.queue = isDurableOp(failedOp) ? [failedOp, ...remainingDurable] : remainingDurable;
    return true;
  }

  private runPendingPurge(storage: StorageLike | null): void {
    this.pendingPurge = false;
    const disabledState = tryIsRecentRoomsDisabled(storage);
    if (!this.disabled && disabledState.ok && !disabledState.disabled) {
      pruneExpiredRecentRooms(storage, this.now());
    }
  }

  private drainQueueUnderLock(): void {
    this.flushRequested = false;
    let reconcile = false;
    let hadStorageError = false;
    const carryPatches = new Map<string, RecentRoomPatchOp[]>();
    try {
      const storage = this.env.getLocalStorage();
      while (this.queue.length > 0) {
        const op = this.queue.shift();
        if (!op) break;
        const result = this.persistStorageOp(storage, op, carryPatches);
        if (result === "external-opt-out") {
          this.applyExternalOptOut(storage);
          carryPatches.clear();
          reconcile = true;
        } else if (result === "reconcile") {
          reconcile = true;
        } else if (result === "storage-error") {
          reconcile = this.abortQueueOnStorageError(op, carryPatches) || reconcile;
          hadStorageError = true;
          break;
        }
      }
      if (!hadStorageError && this.pendingPurge) this.runPendingPurge(storage);
      if (reconcile) {
        this.recomputeView(storage, this.now());
        this.normalizeUiState();
        this.env.onChange();
      }
    } finally {
      this.flushing = false;
      this.pendingPurge = false;
      const shouldReschedule = !hadStorageError && (this.flushRequested || this.queue.length > 0);
      this.flushRequested = false;
      if (shouldReschedule) this.scheduleFlush();
    }
  }

  private maybeScheduleExpiredPurge(storage: StorageLike | null, now: number): void {
    if (this.pendingPurge || this.disabled || this.queue.length > 0 || !hasStaleRecentRooms(storage, now)) {
      return;
    }
    this.pendingPurge = true;
    this.scheduleFlush();
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
    this.enqueueOp(op);
  }

  updatePassword(code: string, password: string | undefined, locked: boolean): void {
    const upper = code.trim().toUpperCase();
    const clean = sanitizePassword(password);
    if (locked || clean === undefined || !isValidRoomCode(upper)) return;
    const existing = this.rooms.find((r) => r.code === upper);
    if ((!existing && !this.failedJoinCodes.has(upper)) || existing?.password === clean) return;
    this.enqueueOp({ kind: "patch", code: upper, field: "password", password: clean });
  }

  updatePeers(code: string, peerNames: readonly string[]): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    const sanitized = sanitizePeerNames(peerNames);
    if (sanitized.length === 0) return;
    const existing = this.rooms.find((r) => r.code === upper);
    if ((!existing && !this.failedJoinCodes.has(upper)) || (existing && sameStringArray(existing.peerNames, sanitized))) {
      return;
    }
    this.enqueueOp({ kind: "patch", code: upper, field: "peerNames", peerNames: sanitized });
  }

  rename(code: string, label: string): void {
    const upper = code.trim().toUpperCase();
    if (!isValidRoomCode(upper)) return;
    const existing = this.rooms.find((r) => r.code === upper);
    this.editingCode = null;
    if (!existing && !this.failedJoinCodes.has(upper)) {
      this.env.onChange();
      return;
    }
    const nextLabel = sanitizeRecentRoomLabel(label);
    this.enqueueOp({
      kind: "patch",
      code: upper,
      field: "label",
      ...(nextLabel !== undefined ? { label: nextLabel } : {}),
    });
  }

  private removeEntry(upper: string, demoteIfPassworded: boolean, cleanupToken?: () => void): boolean {
    const existed = this.rooms.some((r) => r.code === upper);
    this.failedJoinCodes.delete(upper);
    this.queue.push(
      demoteIfPassworded ? { kind: "remove", code: upper, demoteIfPassworded: true } : { kind: "remove", code: upper },
    );
    this.recomputeView(this.env.getLocalStorage(), this.now());
    this.normalizeUiState();
    cleanupToken?.();
    this.scheduleFlush();
    this.env.onChange();
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
    this.pendingPurge = false;
    this.failedJoinCodes.clear();
    if (disabled) {
      this.queue = [{ kind: "set-disabled", disabled: true }, { kind: "clear-all" }];
      this.rooms = [];
      this.env.onForgetAllHostTokens();
    } else {
      this.queue.push({ kind: "set-disabled", disabled: false });
      this.recomputeView(this.env.getLocalStorage(), this.now());
      this.normalizeUiState();
    }
    this.scheduleFlush();
    this.env.onChange();
  }

  clearAll(): void {
    this.pendingPurge = false;
    this.failedJoinCodes.clear();
    this.queue = this.queue.filter((op) => op.kind === "set-disabled" || op.kind === "clear-all");
    const lastOp = this.queue[this.queue.length - 1];
    if (lastOp?.kind !== "clear-all") {
      this.queue.push({ kind: "clear-all" });
    }
    this.rooms = [];
    this.searchQuery = "";
    this.editingCode = null;
    this.env.onForgetAllHostTokens();
    this.scheduleFlush();
    this.env.onChange();
  }

  syncFromStorage(notify: boolean = true): void {
    const storage = this.env.getLocalStorage();
    const now = this.now();
    for (const code of this.failedJoinCodes) {
      if (!this.queue.some((op) => (op.kind === "patch" || op.kind === "join") && op.code === code)) {
        this.failedJoinCodes.delete(code);
      }
    }
    if (!this.queue.some((op) => op.kind === "set-disabled")) {
      const disabledState = tryIsRecentRoomsDisabled(storage);
      if (disabledState.ok && disabledState.disabled) {
        this.applyExternalOptOut(storage);
      } else if (disabledState.ok) {
        this.disabled = false;
      }
    }
    this.recomputeView(storage, now);
    this.normalizeUiState();
    if (this.queue.length > 0) {
      this.scheduleFlush();
    } else {
      this.maybeScheduleExpiredPurge(storage, now);
    }
    if (notify) this.env.onChange();
  }
}
