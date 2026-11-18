import { describe, expect, it } from "vitest";
import {
  HOST_ROOMS_STORAGE_KEY,
  HOST_TOKEN_TTL_MS,
  MAX_STORED_HOST_ROOMS,
  readPersistedHostToken,
  writePersistedHostToken,
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
    writePersistedHostToken(storage, "abcdefgh", "tok-1", now);
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

  it("expires entries at or past HOST_TOKEN_TTL_MS (90 days)", () => {
    const storage = makeMemoryStorage();
    const t0 = 1_700_000_000_000;
    writePersistedHostToken(storage, "ABCDEFGH", "tok-old", t0);
    writePersistedHostToken(storage, "JKMNPQRS", "tok-new", t0 + 10_000);

    expect(readPersistedHostToken(storage, "ABCDEFGH", t0 + HOST_TOKEN_TTL_MS - 1)).toBe("tok-old");
    expect(readPersistedHostToken(storage, "ABCDEFGH", t0 + HOST_TOKEN_TTL_MS)).toBeUndefined();
    expect(readPersistedHostToken(storage, "JKMNPQRS", t0 + HOST_TOKEN_TTL_MS)).toBe("tok-new");

    writePersistedHostToken(storage, "TUVWXYZ2", "tok-3", t0 + HOST_TOKEN_TTL_MS);
    const persisted = JSON.parse(storage.store.get(HOST_ROOMS_STORAGE_KEY) ?? "[]") as Array<{ code: string }>;
    expect(persisted.map((e) => e.code)).toEqual(["JKMNPQRS", "TUVWXYZ2"]);
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
    expect(() => writePersistedHostToken(throwing, "ABCDEFGH", "tok")).not.toThrow();
    expect(() => writePersistedHostToken(throwing, "ABCDEFGH", undefined)).not.toThrow();
  });
});
