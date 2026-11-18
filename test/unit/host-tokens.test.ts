import { describe, expect, it } from "vitest";
import {
  HOST_ROOMS_LOCK_NAME,
  HOST_ROOMS_STORAGE_KEY,
  HOST_TOKEN_TTL_MS,
  MAX_CLOCK_SKEW_MS,
  MAX_STORED_HOST_ROOMS,
  clearAllPersistedHostTokens,
  hasAnyPersistedHostTokens,
  readPersistedHostToken,
  removePersistedHostTokenIfMatching,
  runWithHostRoomsLock,
  writePersistedHostToken,
  type LockManagerLike,
  type StorageLike,
} from "@src/host-tokens";

function makeMemoryStorage(initial: Record<string, string> = {}): StorageLike & { store: Map<string, string> } {
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

describe("host-tokens localStorage persistence", () => {
  it("stores, normalizes case, and reads back a valid host token", () => {
    const storage = makeMemoryStorage();
    const now = 1_000_000;
    expect(hasAnyPersistedHostTokens(null, now)).toBe(false);
    expect(hasAnyPersistedHostTokens(storage, now)).toBe(false);

    writePersistedHostToken(storage, "abcdefgh", "tok-1", now);
    expect(hasAnyPersistedHostTokens(storage, now + 100)).toBe(true);
    expect(readPersistedHostToken(storage, "ABCDEFGH", now + 100)).toBe("tok-1");
    expect(readPersistedHostToken(storage, "abcdefgh", now + 100)).toBe("tok-1");
  });

  it("ignores null/undefined storage and invalid room codes", () => {
    const storage = makeMemoryStorage();
    expect(readPersistedHostToken(null, "ABCDEFGH")).toBeUndefined();
    expect(readPersistedHostToken(undefined, "ABCDEFGH")).toBeUndefined();
    expect(readPersistedHostToken(storage, "BAD")).toBeUndefined();

    writePersistedHostToken(null, "ABCDEFGH", "tok-1");
    writePersistedHostToken(storage, "BAD", "tok-1");
    expect(storage.store.size).toBe(0);
  });

  it("deletes a specific room entry and removes the storage key when empty", () => {
    const storage = makeMemoryStorage();
    writePersistedHostToken(storage, "ABCDEFGH", "tok-1", 1000);
    writePersistedHostToken(storage, "JKMNPQRS", "tok-2", 2000);

    writePersistedHostToken(storage, "abcdefgh", undefined, 3000);
    expect(readPersistedHostToken(storage, "ABCDEFGH", 3000)).toBeUndefined();
    expect(readPersistedHostToken(storage, "JKMNPQRS", 3000)).toBe("tok-2");
    expect(storage.store.has(HOST_ROOMS_STORAGE_KEY)).toBe(true);

    writePersistedHostToken(storage, "JKMNPQRS", "", 4000);
    expect(storage.store.has(HOST_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("expires entries at or past HOST_TOKEN_TTL_MS (90 days) and drops future-skewed entries", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;
    writePersistedHostToken(storage, "ABCDEFGH", "tok-old", t0);
    writePersistedHostToken(storage, "JKMNPQRS", "tok-new", t0 + MAX_CLOCK_SKEW_MS + 10_000);

    expect(readPersistedHostToken(storage, "ABCDEFGH", t0 + HOST_TOKEN_TTL_MS - 1)).toBe("tok-old");
    expect(readPersistedHostToken(storage, "ABCDEFGH", t0 + HOST_TOKEN_TTL_MS)).toBeUndefined();
    expect(readPersistedHostToken(storage, "JKMNPQRS", t0 + HOST_TOKEN_TTL_MS)).toBe("tok-new");

    writePersistedHostToken(storage, "MNPQRSTU", "tok-future", t0 + HOST_TOKEN_TTL_MS + MAX_CLOCK_SKEW_MS + 1);
    expect(readPersistedHostToken(storage, "MNPQRSTU", t0 + HOST_TOKEN_TTL_MS)).toBeUndefined();
    expect(readPersistedHostToken(storage, "MNPQRSTU", t0 + HOST_TOKEN_TTL_MS + 1)).toBe("tok-future");

    writePersistedHostToken(storage, "TUVWXYZ2", "tok-3", t0 + HOST_TOKEN_TTL_MS);
    const rawParsed: unknown = JSON.parse(storage.store.get(HOST_ROOMS_STORAGE_KEY) ?? "[]");
    const isCodeEntry = (item: unknown): item is { code: unknown } =>
      typeof item === "object" && item !== null && "code" in item;
    const codes = Array.isArray(rawParsed)
      ? rawParsed.map((item) => (isCodeEntry(item) ? String(item.code) : "")).filter(Boolean)
      : [];
    expect(codes).toEqual(["JKMNPQRS", "TUVWXYZ2"]);
  });

  it("removes a room token only when it matches expectedToken and supports clearAll", () => {
    const storage = makeMemoryStorage();
    writePersistedHostToken(storage, "ABCDEFGH", "tok-newer", 2000);
    writePersistedHostToken(storage, "JKMNPQRS", "tok-other", 2000);

    expect(removePersistedHostTokenIfMatching(storage, "ABCDEFGH", "tok-stale", 2500)).toBe(false);
    expect(readPersistedHostToken(storage, "ABCDEFGH", 2500)).toBe("tok-newer");

    expect(removePersistedHostTokenIfMatching(storage, "BAD", "tok-newer", 2500)).toBe(false);
    expect(removePersistedHostTokenIfMatching(storage, "ABCDEFGH", undefined, 2500)).toBe(false);
    expect(removePersistedHostTokenIfMatching(storage, "abcdefgh", "tok-newer", 2500)).toBe(true);
    expect(readPersistedHostToken(storage, "ABCDEFGH", 2500)).toBeUndefined();
    expect(readPersistedHostToken(storage, "JKMNPQRS", 2500)).toBe("tok-other");

    clearAllPersistedHostTokens(null);
    clearAllPersistedHostTokens(storage);
    expect(storage.store.has(HOST_ROOMS_STORAGE_KEY)).toBe(false);
  });

  it("evicts the oldest entries beyond MAX_STORED_HOST_ROOMS (20) and promotes re-saved rooms", () => {
    const storage = makeMemoryStorage();
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const makeCode = (idx: number): string => `${alphabet[idx] ?? "A"}BCDEFG2`;

    for (let i = 0; i < MAX_STORED_HOST_ROOMS; i++) {
      writePersistedHostToken(storage, makeCode(i), `tok-${i}`, 1000 + i * 10);
    }
    // Refresh room 0 so room 1 becomes the oldest LRU entry.
    writePersistedHostToken(storage, makeCode(0), "tok-0-refreshed", 5000);
    // Adding a 21st room should evict room 1, while keeping room 0.
    writePersistedHostToken(storage, makeCode(MAX_STORED_HOST_ROOMS), "tok-new", 6000);

    expect(readPersistedHostToken(storage, makeCode(1), 6000)).toBeUndefined();
    expect(readPersistedHostToken(storage, makeCode(0), 6000)).toBe("tok-0-refreshed");
    expect(readPersistedHostToken(storage, makeCode(MAX_STORED_HOST_ROOMS), 6000)).toBe("tok-new");
  });

  it("serializes concurrent storage updates via Web Locks and falls back when locks are absent or fail", async () => {
    const storage = makeMemoryStorage();
    let tail: Promise<void> = Promise.resolve();
    const requestedNames: string[] = [];
    const serializedLocks: LockManagerLike = {
      request: async (name, cb) => {
        requestedNames.push(name);
        const prev = tail;
        let release: () => void = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prev;
        try {
          await cb();
        } finally {
          release();
        }
      },
    };

    await Promise.all([
      runWithHostRoomsLock(serializedLocks, () => {
        writePersistedHostToken(storage, "ABCDEFGH", "tok-a", 1000);
      }),
      runWithHostRoomsLock(serializedLocks, () => {
        writePersistedHostToken(storage, "JKMNPQRS", "tok-b", 1001);
      }),
    ]);

    expect(requestedNames).toEqual([HOST_ROOMS_LOCK_NAME, HOST_ROOMS_LOCK_NAME]);
    expect(readPersistedHostToken(storage, "ABCDEFGH", 1002)).toBe("tok-a");
    expect(readPersistedHostToken(storage, "JKMNPQRS", 1002)).toBe("tok-b");

    await runWithHostRoomsLock(null, () => {
      writePersistedHostToken(storage, "MNPQRSTU", "tok-c", 1003);
    });
    expect(readPersistedHostToken(storage, "MNPQRSTU", 1004)).toBe("tok-c");

    const failingLocks: LockManagerLike = {
      request: () => Promise.reject(new Error("locks disabled")),
    };
    await runWithHostRoomsLock(failingLocks, () => {
      writePersistedHostToken(storage, "PQRSTUVW", "tok-d", 1005);
    });
    expect(readPersistedHostToken(storage, "PQRSTUVW", 1006)).toBe("tok-d");
  });

  it("handles corrupted JSON, mixed invalid entries, duplicates, and storage errors safely", () => {
    const badJson = makeMemoryStorage({ [HOST_ROOMS_STORAGE_KEY]: "{not json" });
    expect(readPersistedHostToken(badJson, "ABCDEFGH")).toBeUndefined();

    const nonArray = makeMemoryStorage({ [HOST_ROOMS_STORAGE_KEY]: JSON.stringify({ code: "ABCDEFGH" }) });
    expect(readPersistedHostToken(nonArray, "ABCDEFGH")).toBeUndefined();

    const mixed = makeMemoryStorage({
      [HOST_ROOMS_STORAGE_KEY]: JSON.stringify([
        null,
        { code: "INVALID", token: "bad", updatedAt: 1000 },
        { code: "ABCDEFGH", token: "", updatedAt: 1000 },
        { code: "ABCDEFGH", token: "older", updatedAt: 1000 },
        { code: "ABCDEFGH", token: "newer", updatedAt: 2000 },
        { code: "JKMNPQRS", token: "valid-2", updatedAt: 1500 },
      ]),
    });
    expect(readPersistedHostToken(mixed, "ABCDEFGH", 3000)).toBe("newer");
    expect(readPersistedHostToken(mixed, "JKMNPQRS", 3000)).toBe("valid-2");

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPersistedHostToken(throwing, "ABCDEFGH")).toBeUndefined();
    expect(hasAnyPersistedHostTokens(throwing)).toBe(false);
    expect(() => writePersistedHostToken(throwing, "ABCDEFGH", "tok")).not.toThrow();
    expect(() => writePersistedHostToken(throwing, "ABCDEFGH", undefined)).not.toThrow();
    expect(() => clearAllPersistedHostTokens(throwing)).not.toThrow();
  });
});
