import { describe, expect, it } from "vitest";
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  generateRoomCode,
  isValidRoomCode,
  parseClientMessage,
} from "@shared/protocol";

describe("generateRoomCode", () => {
  it("produces codes of the declared length from the declared alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
  });

  it("excludes visually ambiguous characters", () => {
    // Codes get read aloud and retyped, so O/0 and I/1/L must not both exist.
    for (const ch of "O0I1L") expect(ROOM_CODE_ALPHABET).not.toContain(ch);
  });

  it("is not obviously biased across the alphabet", () => {
    // Rejection sampling should reach every symbol; modulo bias would starve the tail.
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const ch of generateRoomCode()) seen.add(ch);
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length);
  });

  it("has enough entropy that codes are not guessable", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) codes.add(generateRoomCode());
    expect(codes.size).toBe(1000);
  });
});

describe("isValidRoomCode", () => {
  it("accepts generated codes", () => {
    for (let i = 0; i < 50; i++) expect(isValidRoomCode(generateRoomCode())).toBe(true);
  });

  it("rejects wrong lengths", () => {
    expect(isValidRoomCode("")).toBe(false);
    expect(isValidRoomCode("ABCDEFG")).toBe(false);
    expect(isValidRoomCode("ABCDEFGHJ")).toBe(false);
  });

  it("rejects characters outside the alphabet", () => {
    expect(isValidRoomCode("ABCDEFG0")).toBe(false);
    expect(isValidRoomCode("ABCDEFGO")).toBe(false);
    expect(isValidRoomCode("abcdefgh")).toBe(false); // lowercase
    expect(isValidRoomCode("ABCDEF-H")).toBe(false);
  });

  it("rejects path traversal attempts, since the code names a Durable Object", () => {
    expect(isValidRoomCode("../../etc")).toBe(false);
    expect(isValidRoomCode("A/B/C/D/E")).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("accepts a well-formed join", () => {
    expect(parseClientMessage(JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "mik" })))
      .toEqual({ t: "join", room: "ABCDEFGH", displayName: "mik" });
  });

  it("accepts offer and answer signals", () => {
    const offer = parseClientMessage(JSON.stringify({ t: "signal", to: "p1", data: { k: "offer", sdp: "v=0" } }));
    expect(offer).toEqual({ t: "signal", to: "p1", data: { k: "offer", sdp: "v=0" } });
    const answer = parseClientMessage(JSON.stringify({ t: "signal", to: "p1", data: { k: "answer", sdp: "v=0" } }));
    expect(answer).toEqual({ t: "signal", to: "p1", data: { k: "answer", sdp: "v=0" } });
  });

  it("accepts an ICE candidate and normalises absent fields to null", () => {
    const msg = parseClientMessage(
      JSON.stringify({ t: "signal", to: "p1", data: { k: "ice", candidate: { candidate: "candidate:1 1 udp" } } }),
    );
    expect(msg).toEqual({
      t: "signal",
      to: "p1",
      data: { k: "ice", candidate: { candidate: "candidate:1 1 udp", sdpMid: null, sdpMLineIndex: null } },
    });
  });

  it("preserves sdpMid and sdpMLineIndex when present", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        t: "signal",
        to: "p1",
        data: { k: "ice", candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "abc" } },
      }),
    );
    expect(msg).toMatchObject({
      data: { k: "ice", candidate: { sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "abc" } },
    });
  });

  it("accepts a state message", () => {
    expect(parseClientMessage(JSON.stringify({ t: "state", sharing: true })))
      .toEqual({ t: "state", sharing: true });
  });

  it("strips unknown fields rather than forwarding them", () => {
    // The server echoes `data` verbatim to other peers, so nothing unvalidated
    // should survive parsing.
    const msg = parseClientMessage(
      JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "mik", isAdmin: true }),
    );
    expect(msg).not.toHaveProperty("isAdmin");
  });

  it("returns null for malformed input instead of throwing", () => {
    const bad = [
      "", "not json", "[]", "null", "42", '"str"',
      JSON.stringify({}),
      JSON.stringify({ t: "unknown" }),
      JSON.stringify({ t: "join", room: 5, displayName: "x" }),
      JSON.stringify({ t: "join", room: "ABCDEFGH" }),
      JSON.stringify({ t: "state", sharing: "yes" }),
      JSON.stringify({ t: "signal", to: "p1" }),
      JSON.stringify({ t: "signal", to: 1, data: { k: "offer", sdp: "v=0" } }),
      JSON.stringify({ t: "signal", to: "p1", data: { k: "offer" } }),
      JSON.stringify({ t: "signal", to: "p1", data: { k: "nope", sdp: "v=0" } }),
      JSON.stringify({ t: "signal", to: "p1", data: { k: "ice", candidate: { sdpMid: "0" } } }),
      JSON.stringify({ t: "signal", to: "p1", data: { k: "ice", candidate: null } }),
      JSON.stringify({ t: "signal", to: "p1", data: [] }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw), raw).toBeNull();
  });
});
