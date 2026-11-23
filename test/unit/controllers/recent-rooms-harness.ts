import { vi, type Mock } from "vitest";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import {
  sanitizePassword,
  sanitizePeerNames,
  sanitizeRecentRoomLabel,
  sortAndBoundEntries,
  tryIsRecentRoomsDisabled,
  tryLoadRecentRooms,
  writePersistedRecentRooms,
  type LockManagerLike,
  type RecentRoomEntry,
  type StorageLike,
} from "@src/recent-rooms";
import type { RecentRoomRole } from "@src/recent-rooms-model";

export interface MemoryStorage extends StorageLike {
  store: Map<string, string>;
}

export function createFullMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.get(key) ?? null;
    },
    key(i) {
      return [...store.keys()][i] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

export function makeMemoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

export function loadRecentRooms(storage: StorageLike | null | undefined, now: number = Date.now()): RecentRoomEntry[] {
  return tryLoadRecentRooms(storage, now).entries;
}

export function isRecentRoomsDisabled(storage: StorageLike | null | undefined): boolean {
  return tryIsRecentRoomsDisabled(storage).disabled;
}

export interface TestUpsertInput {
  code: string;
  role: RecentRoomRole;
  lastJoinedAt?: number;
  peerNames?: readonly string[];
  password?: string;
  label?: string;
}

export function upsertRecentRoom(
  storage: StorageLike | null | undefined,
  input: TestUpsertInput,
  now: number = Date.now(),
): RecentRoomEntry[] {
  const code = input.code.trim().toUpperCase();
  const entries = loadRecentRooms(storage, now);
  if (!storage) return entries;
  const existing = entries.find((e) => e.code === code);
  const password = sanitizePassword(input.password) ?? existing?.password;
  const label = input.label !== undefined ? sanitizeRecentRoomLabel(input.label) : existing?.label;
  const incomingPeers = sanitizePeerNames(input.peerNames);
  const peerNames = incomingPeers.length > 0 ? incomingPeers : (existing?.peerNames ?? []);
  const nextEntry: RecentRoomEntry = {
    code,
    role: input.role,
    lastJoinedAt: input.lastJoinedAt ?? now,
    peerNames,
    ...(password !== undefined ? { password } : {}),
    ...(label !== undefined ? { label } : {}),
  };
  const next = sortAndBoundEntries([nextEntry, ...entries.filter((e) => e.code !== code)]);
  writePersistedRecentRooms(storage, next);
  return next;
}

export interface RecentRoomsHarness {
  ctrl: RecentRoomsController;
  storage: MemoryStorage;
  creatorCodes: Set<string>;
  tasks: Promise<unknown>[];
  pendingLockReleases: Array<() => void>;
  onRemoveHostToken: Mock<(code: string) => void>;
  onForgetAllHostTokens: Mock<() => void>;
  onChange: Mock<() => void>;
  flush: () => Promise<void>;
}

export function makeHarness(options?: {
  initialStorage?: Record<string, string>;
  creatorCodes?: Set<string>;
  now?: () => number;
  deferredLocks?: boolean;
}): RecentRoomsHarness {
  const storage = makeMemoryStorage(options?.initialStorage);
  const creatorCodes = options?.creatorCodes ?? new Set<string>();
  const tasks: Promise<unknown>[] = [];
  const pendingLockReleases: Array<() => void> = [];
  const nowFn = options?.now ?? (() => 1_700_000_000_000);
  const onRemoveHostToken = vi.fn((code: string) => {
    creatorCodes.delete(code);
  });
  const onForgetAllHostTokens = vi.fn(() => {
    creatorCodes.clear();
  });
  const onChange = vi.fn();

  const locks: LockManagerLike | null = options?.deferredLocks
    ? {
        request: async (_name, cb) => {
          await new Promise<void>((resolve) => {
            pendingLockReleases.push(() => {
              void Promise.resolve(cb()).finally(resolve);
            });
          });
        },
      }
    : null;

  const ctrl = new RecentRoomsController({
    getLocalStorage: () => storage,
    getLocks: () => locks,
    runBackground: (t) => {
      tasks.push(t);
    },
    hasSavedCreatorHostFor: (code) => creatorCodes.has(code),
    onRemoveHostToken,
    onForgetAllHostTokens,
    onChange,
    now: nowFn,
  });

  const flush = async (): Promise<void> => {
    while (pendingLockReleases.length > 0) {
      const next = pendingLockReleases.shift();
      next?.();
      await Promise.resolve();
    }
    await Promise.all(tasks);
  };

  return {
    ctrl,
    storage,
    creatorCodes,
    tasks,
    pendingLockReleases,
    onRemoveHostToken,
    onForgetAllHostTokens,
    onChange,
    flush,
  };
}
