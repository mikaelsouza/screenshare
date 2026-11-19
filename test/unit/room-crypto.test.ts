import { describe, expect, it, vi } from "vitest";
import {
  hashRoomSecret,
  preMintEmptyResetSecret,
  preMintRotationCredentials,
  timingSafeEqualStr,
} from "@worker/room-crypto";

describe("worker/room-crypto", () => {
  it("timingSafeEqualStr compares equal, unequal, and mismatched-length strings", () => {
    expect(timingSafeEqualStr("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualStr("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualStr("abc123", "abc12")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("a", "")).toBe(false);
  });

  it("timingSafeEqualStr delegates to native crypto.subtle.timingSafeEqual when present", () => {
    const spy = vi.fn(() => true);
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: spy,
      configurable: true,
      writable: true,
    });
    try {
      expect(timingSafeEqualStr("same", "diff")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
    }
  });

  it("hashRoomSecret produces 64-char hex SHA-256 digests with domain & room separation", async () => {
    const h1 = await hashRoomSecret("room-1", "SECRET", "password");
    const h2 = await hashRoomSecret("room-1", "SECRET", "password");
    const hHost = await hashRoomSecret("room-1", "SECRET", "host");
    const hRejoin = await hashRoomSecret("room-1", "SECRET", "rejoin");
    const hOtherRoom = await hashRoomSecret("room-2", "SECRET", "password");

    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(hHost);
    expect(h1).not.toBe(hRejoin);
    expect(hHost).not.toBe(hRejoin);
    expect(h1).not.toBe(hOtherRoom);
  });

  it("preMintEmptyResetSecret returns a fresh invite secret and matching hash", async () => {
    const minted = await preMintEmptyResetSecret("room-alpha");
    expect(minted.password.length).toBeGreaterThanOrEqual(8);
    expect(minted.passwordHash).toBe(await hashRoomSecret("room-alpha", minted.password, "password"));
  });

  it("preMintRotationCredentials mints password + N unique rejoin tickets and clamps negative counts", async () => {
    const creds = await preMintRotationCredentials("room-beta", 3);
    expect(creds.newPasswordHash).toBe(await hashRoomSecret("room-beta", creds.newPassword, "password"));
    expect(creds.tickets).toHaveLength(3);
    const tokens = new Set(creds.tickets.map((t) => t.token));
    expect(tokens.size).toBe(3);
    for (const ticket of creds.tickets) {
      expect(ticket.hash).toBe(await hashRoomSecret("room-beta", ticket.token, "rejoin"));
    }

    const zero = await preMintRotationCredentials("room-beta", -2);
    expect(zero.tickets).toEqual([]);
  });
});
