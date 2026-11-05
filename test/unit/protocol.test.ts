import { describe, expect, it } from "vitest";
import {
  MAX_CANDIDATE_LENGTH,
  MAX_SDP_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  generateRoomCode,
  isValidRoomCode,
  parseClientMessage,
} from "@shared/protocol";

const P1 = "3f2c1a9e-8b4d-4c1e-9a7f-0e5d6c4b3a21";

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

  it("rejects non-string inputs safely", () => {
    expect(isValidRoomCode(123 as unknown as string)).toBe(false);
    expect(isValidRoomCode(null as unknown as string)).toBe(false);
    expect(isValidRoomCode(undefined as unknown as string)).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("accepts a well-formed join", () => {
    expect(parseClientMessage(JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "mik" })))
      .toEqual({ t: "join", room: "ABCDEFGH", displayName: "mik" });
  });

  it("accepts offer and answer signals", () => {
    const offer = parseClientMessage(JSON.stringify({ t: "signal", to: P1, data: { k: "offer", sdp: "v=0" } }));
    expect(offer).toEqual({ t: "signal", to: P1, data: { k: "offer", sdp: "v=0" } });
    const answer = parseClientMessage(JSON.stringify({ t: "signal", to: P1, data: { k: "answer", sdp: "v=0" } }));
    expect(answer).toEqual({ t: "signal", to: P1, data: { k: "answer", sdp: "v=0" } });
  });

  it("accepts an ICE candidate and normalises absent fields to null", () => {
    const msg = parseClientMessage(
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: { candidate: "candidate:1 1 udp" } } }),
    );
    expect(msg).toEqual({
      t: "signal",
      to: P1,
      data: { k: "ice", candidate: { candidate: "candidate:1 1 udp", sdpMid: null, sdpMLineIndex: null } },
    });
  });

  it("preserves sdpMid and sdpMLineIndex when present", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        t: "signal",
        to: P1,
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

  it("accepts a join message with a password", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ t: "join", room: "ABCDEFGH", displayName: "mik", password: "secret" }),
      ),
    ).toEqual({ t: "join", room: "ABCDEFGH", displayName: "mik", password: "secret" });
  });

  it("handles usernameFragment explicitly set to null", () => {
    const msg = parseClientMessage(
      JSON.stringify({
        t: "signal",
        to: P1,
        data: { k: "ice", candidate: { candidate: "c", usernameFragment: null } },
      }),
    );
    expect(msg).toMatchObject({
      data: { k: "ice", candidate: { candidate: "c", usernameFragment: null } },
    });
  });

  it("returns null for malformed input instead of throwing", () => {
    const bad = [
      "", "not json", "[]", "null", "42", '"str"',
      JSON.stringify({}),
      JSON.stringify({ t: "unknown" }),
      JSON.stringify({ t: "join", room: 5, displayName: "x" }),
      JSON.stringify({ t: "join", room: "ABCDEFGH" }),
      JSON.stringify({ t: "state", sharing: "yes" }),
      JSON.stringify({ t: "signal", to: P1 }),
      JSON.stringify({ t: "signal", to: 1, data: { k: "offer", sdp: "v=0" } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "offer" } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "offer", sdp: 123 } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "answer", sdp: 123 } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "nope", sdp: "v=0" } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: { sdpMid: "0" } } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: { candidate: 123 } } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: { candidate: "c", sdpMid: 123 } } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: { candidate: "c", sdpMLineIndex: "0" } } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: { candidate: "c", usernameFragment: 123 } } }),
      JSON.stringify({ t: "signal", to: P1, data: { k: "ice", candidate: null } }),
      JSON.stringify({ t: "signal", to: P1, data: [] }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw)).toBeNull();
  });
});

describe("signal size limits", () => {
  // Unbounded, a joined peer could send a 1 MB sdp in a tight loop: every frame wakes
  // the Durable Object and is forwarded verbatim to the victim's socket — amplification
  // against a peer, plus unbounded object CPU and wall-clock billing.
  const sig = (data: unknown): unknown =>
    parseClientMessage(JSON.stringify({ t: "signal", to: P1, data }));

  it("accepts an SDP right at the limit and rejects one byte more", () => {
    expect(sig({ k: "offer", sdp: "v".repeat(MAX_SDP_LENGTH) })).not.toBeNull();
    expect(sig({ k: "offer", sdp: "v".repeat(MAX_SDP_LENGTH + 1) })).toBeNull();
    expect(sig({ k: "answer", sdp: "v".repeat(MAX_SDP_LENGTH) })).not.toBeNull();
    expect(sig({ k: "answer", sdp: "v".repeat(MAX_SDP_LENGTH + 1) })).toBeNull();
  });

  it("accepts a candidate at the limit and rejects one byte more", () => {
    const cand = (n: number) => ({
      k: "ice",
      candidate: { candidate: "c".repeat(n), sdpMid: "0", sdpMLineIndex: 0 },
    });
    expect(sig(cand(MAX_CANDIDATE_LENGTH))).not.toBeNull();
    expect(sig(cand(MAX_CANDIDATE_LENGTH + 1))).toBeNull();
  });

  it("still accepts a realistically sized offer", () => {
    // The cap must not be so tight that an 8-way mesh offer trips it.
    expect(sig({ k: "offer", sdp: "v=0\r\n" + "a=rtpmap:111 opus/48000/2\r\n".repeat(200) })).not.toBeNull();
  });

  it("rejects an empty-string sdp as it would any malformed signal", () => {
    expect(sig({ k: "offer", sdp: "" })).not.toBeNull();
    expect(sig({ k: "offer" })).toBeNull();
    expect(sig({ k: "offer", sdp: 123 })).toBeNull();
  });
});

describe("parseClientMessage peer ids", () => {
  it.each([
    ["an arbitrary string", "p1"],
    ["an uppercase uuid", P1.toUpperCase()],
    ["a very long string", "a".repeat(10_000)],
    ["an empty string", ""],
  ])("rejects a signal addressed to %s", (_name, to) => {
    expect(parseClientMessage(JSON.stringify({ t: "signal", to, data: { k: "offer", sdp: "v=0" } }))).toBeNull();
  });
});

describe("parseClientMessage join options", () => {
  it("parses resume and sharing when valid booleans", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        t: "join",
        room: "ABCDEFGH",
        displayName: "alice",
        rejoinToken: "tok123",
        resume: true,
        sharing: true,
      }),
    );
    expect(parsed).toEqual({
      t: "join",
      room: "ABCDEFGH",
      displayName: "alice",
      rejoinToken: "tok123",
      resume: true,
      sharing: true,
    });
  });

  it("ignores non-boolean or false resume and sharing values", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        t: "join",
        room: "ABCDEFGH",
        displayName: "alice",
        resume: "true",
        sharing: "yes",
      }),
    );
    expect(parsed).toEqual({
      t: "join",
      room: "ABCDEFGH",
      displayName: "alice",
    });
  });
});

