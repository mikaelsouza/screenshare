import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseClientMessage,
  parseServerMessage,
  parseInviteInput,
  isValidRoomCode,
  isValidRoomPassword,
  type ClientMessage,
  MAX_SDP_LENGTH,
  MAX_CANDIDATE_LENGTH,
  MAX_CHAT_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_PASSWORD_LENGTH,
} from "@shared/protocol";

describe("Fuzzing Suite: Client Message & Candidate Parser (Features 41, 45)", () => {
  const PEER_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /**
   * Feature 41: Arbitrary string and corrupt JSON fuzzing
   * Invariant: parseClientMessage NEVER throws and always returns null or valid ClientMessage.
   */
  it("never crashes on arbitrary strings, unicode, or binary noise", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let result: ClientMessage | null = null;
        try {
          result = parseClientMessage(raw);
        } catch (err) {
          expect.fail(`parseClientMessage threw unexpectedly: ${String(err)}`);
        }

        if (result !== null) {
          expect(typeof result).toBe("object");
          expect(["join", "signal", "state", "kick", "lock", "rotate-password", "rename", "chat"]).toContain(
            result.t,
          );
        }
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  /**
   * Prototype pollution fuzzing: payloads attempting __proto__ or constructor poisoning
   */
  it("safely handles prototype pollution vectors without polluting Object.prototype", () => {
    const pollutionPayloads = [
      '{"t":"join","room":"TEST","displayName":"x","__proto__":{"polluted":"yes"}}',
      '{"t":"join","room":"TEST","displayName":"x","constructor":{"prototype":{"polluted":"yes"}}}',
      '{"__proto__":{"t":"join"}}',
      '{"t":"signal","to":"00000000-0000-0000-0000-000000000000","data":{"__proto__":{"k":"offer"}}}',
      '{"t":"state","sharing":true,"__proto__":{"isAdmin":true}}',
    ];

    for (const payload of pollutionPayloads) {
      expect(() => parseClientMessage(payload)).not.toThrow();
      expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>)["isAdmin"]).toBeUndefined();
    }

    fc.assert(
      fc.property(
        fc.record({
          prop: fc.constantFrom("__proto__", "constructor", "prototype"),
          key: fc.stringMatching(/^[a-z]{1,8}$/),
          val: fc.anything(),
        }),
        ({ prop, key, val }) => {
          const evilObj = { [prop]: { [key]: val } };
          const serialized = JSON.stringify(evilObj);

          expect(() => parseClientMessage(serialized)).not.toThrow();
          expect((Object.prototype as Record<string, unknown>)[key]).toBeUndefined();
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });

  function assertJoinInvariants(result: Extract<ReturnType<typeof parseClientMessage>, { t: "join" }>): void {
    expect(typeof result.room).toBe("string");
    expect(typeof result.displayName).toBe("string");
    if (result.password !== undefined) {
      expect(typeof result.password).toBe("string");
      expect(result.password.length).toBeLessThanOrEqual(128);
    }
    if (result.hostToken !== undefined) {
      expect(typeof result.hostToken).toBe("string");
      expect(result.hostToken.length).toBeLessThanOrEqual(64);
    }
    if (result.rejoinToken !== undefined) {
      expect(typeof result.rejoinToken).toBe("string");
      expect(result.rejoinToken.length).toBeLessThanOrEqual(64);
    }
    if (result.resume !== undefined) expect(result.resume).toBe(true);
    if (result.sharing !== undefined) expect(typeof result.sharing).toBe("boolean");
  }

  function assertSignalInvariants(result: Extract<ReturnType<typeof parseClientMessage>, { t: "signal" }>): void {
    expect(PEER_ID_REGEX.test(result.to)).toBe(true);
    expect(typeof result.data).toBe("object");
    expect(["offer", "answer", "ice"]).toContain(result.data.k);

    if (result.data.k === "offer" || result.data.k === "answer") {
      expect(typeof result.data.sdp).toBe("string");
      expect(result.data.sdp.length).toBeLessThanOrEqual(MAX_SDP_LENGTH);
    } else {
      expect(typeof result.data.candidate.candidate).toBe("string");
      expect(result.data.candidate.candidate.length).toBeLessThanOrEqual(MAX_CANDIDATE_LENGTH);
      const mid = result.data.candidate.sdpMid;
      expect(typeof mid === "string" || mid === null).toBe(true);
      const mline = result.data.candidate.sdpMLineIndex;
      expect(typeof mline === "number" || mline === null).toBe(true);
    }
  }

  /**
   * Synthesized JSON fuzzing: deeply nested structures, mutated types, boundary values
   */
  it("enforces structural invariants when parsing arbitrary JSON values", () => {
    fc.assert(
      fc.property(fc.anything(), (arbitraryValue) => {
        let serialized: string;
        try {
          serialized = JSON.stringify(arbitraryValue);
        } catch {
          return true;
        }

        if (serialized === undefined) return true;

        const result = parseClientMessage(serialized);
        if (result === null) return true;

        if (result.t === "join") assertJoinInvariants(result);
        else if (result.t === "signal") assertSignalInvariants(result);
        else if (result.t === "state") expect(typeof result.sharing).toBe("boolean");
        else if (result.t === "kick") expect(PEER_ID_REGEX.test(result.id)).toBe(true);
        else if (result.t === "lock") expect(typeof result.locked).toBe("boolean");
        else if (result.t === "rotate-password") expect(result.t).toBe("rotate-password");
        else if (result.t === "rename") {
          expect(typeof result.displayName).toBe("string");
          expect(result.displayName.length).toBeLessThanOrEqual(128);
        } else {
          expect(result.t).toBe("chat");
          expect(typeof result.text).toBe("string");
          expect(result.text.length).toBeGreaterThanOrEqual(1);
          expect(result.text.length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
        }

        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("enforces structural invariants across structured 8-variant ClientMessage fuzzing", () => {
    const signalDataArb = fc.oneof(
      fc.record({ k: fc.constant("offer" as const), sdp: fc.string({ maxLength: 512 }) }),
      fc.record({ k: fc.constant("answer" as const), sdp: fc.string({ maxLength: 512 }) }),
      fc.record({
        k: fc.constant("ice" as const),
        candidate: fc.record({
          candidate: fc.string({ maxLength: 256 }),
          sdpMid: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
          sdpMLineIndex: fc.option(fc.nat({ max: 16 }), { nil: null }),
          usernameFragment: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
        }),
      }),
    );

    const optStr = (maxLength: number) => fc.option(fc.string({ maxLength }), { nil: undefined });
    const clientMessageArb = fc.oneof(
      fc.record({
        t: fc.constant("join" as const),
        room: fc.string({ maxLength: 32 }),
        displayName: fc.string({ maxLength: 600 }),
        password: optStr(160),
        hostToken: optStr(96),
        rejoinToken: optStr(96),
        resume: fc.option(fc.oneof(fc.boolean(), fc.string({ maxLength: 8 })), { nil: undefined }),
        sharing: fc.option(fc.oneof(fc.boolean(), fc.string({ maxLength: 8 })), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("signal" as const),
        to: fc.oneof(fc.uuid(), fc.string({ maxLength: 40 })),
        data: signalDataArb,
      }),
      fc.record({ t: fc.constant("state" as const), sharing: fc.boolean() }),
      fc.record({ t: fc.constant("kick" as const), id: fc.oneof(fc.uuid(), fc.string({ maxLength: 40 })) }),
      fc.record({ t: fc.constant("lock" as const), locked: fc.boolean() }),
      fc.record({ t: fc.constant("rotate-password" as const) }),
      fc.record({ t: fc.constant("rename" as const), displayName: fc.string({ maxLength: 160 }) }),
      fc.record({ t: fc.constant("chat" as const), text: fc.string({ maxLength: MAX_CHAT_LENGTH + 50 }) }),
    );

    fc.assert(
      fc.property(clientMessageArb, (payload) => {
        const result = parseClientMessage(JSON.stringify(payload));
        if (result === null) {
          if (payload.t === "join") expect(payload.displayName.length).toBeGreaterThan(512);
          else if (payload.t === "rename") expect(payload.displayName.length).toBeGreaterThan(128);
          else if (payload.t === "chat") {
            expect(payload.text.length === 0 || payload.text.length > MAX_CHAT_LENGTH).toBe(true);
          }
          return true;
        }
        if (result.t === "join") {
          assertJoinInvariants(result);
          expect(result.displayName.length).toBeLessThanOrEqual(512);
          expect(result.hostToken).not.toBe("");
          expect(result.rejoinToken).not.toBe("");
          expect(result.password).not.toBe("");
        } else if (result.t === "signal") {
          assertSignalInvariants(result);
        } else if (result.t === "state") {
          expect(typeof result.sharing).toBe("boolean");
        } else if (result.t === "kick") {
          expect(PEER_ID_REGEX.test(result.id)).toBe(true);
        } else if (result.t === "lock") {
          expect(typeof result.locked).toBe("boolean");
        } else if (result.t === "rotate-password") {
          expect(result.t).toBe("rotate-password");
        } else if (result.t === "rename") {
          expect(result.displayName.length).toBeLessThanOrEqual(128);
        } else {
          expect(result.t).toBe("chat");
          expect(result.text.length).toBeGreaterThanOrEqual(1);
          expect(result.text.length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
        }
        return true;
      }),
      { numRuns: 700 },
    );
  });

  it("parseServerMessage never crashes on arbitrary strings or JSON payloads", () => {
    const validTypes = [
      "welcome",
      "peer-joined",
      "peer-left",
      "signal",
      "peer-state",
      "room-state",
      "room-password",
      "peer-renamed",
      "host-promoted",
      "chat",
      "error",
    ];

    fc.assert(
      fc.property(fc.string(), (raw) => {
        const res = parseServerMessage(raw);
        if (res !== null) {
          expect(validTypes).toContain(res.t);
        }
        return true;
      }),
      { numRuns: 300 },
    );

    const peerInfoArb = fc.record({
      id: fc.string({ maxLength: 40 }),
      name: fc.string({ maxLength: 40 }),
      sharing: fc.boolean(),
      host: fc.option(fc.boolean(), { nil: undefined }),
    });
    const serverSignalDataArb = fc.oneof(
      fc.record({ k: fc.constant("offer" as const), sdp: fc.string({ maxLength: 256 }) }),
      fc.record({ k: fc.constant("answer" as const), sdp: fc.string({ maxLength: 256 }) }),
      fc.record({
        k: fc.constant("ice" as const),
        candidate: fc.record({
          candidate: fc.string({ maxLength: 128 }),
          sdpMid: fc.option(fc.string({ maxLength: 16 }), { nil: null }),
          sdpMLineIndex: fc.option(fc.nat({ max: 8 }), { nil: null }),
        }),
      }),
    );

    const serverMessageArb = fc.oneof(
      fc.jsonValue(),
      fc.record({
        t: fc.constant("welcome" as const),
        selfId: fc.string({ maxLength: 40 }),
        peers: fc.array(peerInfoArb, { maxLength: 5 }),
        host: fc.option(fc.boolean(), { nil: undefined }),
        password: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
        hostToken: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
        rejoinToken: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
        locked: fc.option(fc.boolean(), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("peer-joined" as const),
        peer: peerInfoArb,
        replaces: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("peer-left" as const),
        id: fc.string({ maxLength: 40 }),
        kicked: fc.option(fc.boolean(), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("signal" as const),
        from: fc.string({ maxLength: 40 }),
        data: serverSignalDataArb,
      }),
      fc.record({
        t: fc.constant("peer-state" as const),
        id: fc.string({ maxLength: 40 }),
        sharing: fc.boolean(),
      }),
      fc.record({
        t: fc.constant("room-state" as const),
        locked: fc.boolean(),
        password: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("room-password" as const),
        password: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
        rejoinToken: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("peer-renamed" as const),
        id: fc.string({ maxLength: 40 }),
        name: fc.string({ maxLength: 40 }),
      }),
      fc.record({
        t: fc.constant("host-promoted" as const),
        hostId: fc.string({ maxLength: 40 }),
        hostToken: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
        password: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
      }),
      fc.record({
        t: fc.constant("chat" as const),
        id: fc.string({ maxLength: 80 }),
        from: fc.string({ maxLength: 40 }),
        name: fc.string({ maxLength: 48 }),
        text: fc.string({ maxLength: MAX_CHAT_LENGTH + 50 }),
        ts: fc.oneof(fc.double(), fc.integer(), fc.constantFrom(0, -0, NaN, Infinity, -Infinity)),
      }),
      fc.record({
        t: fc.constant("error" as const),
        code: fc.constantFrom(
          "room-full",
          "bad-message",
          "unknown-peer",
          "bad-room-code",
          "bad-password",
          "session-replaced",
          "forbidden-origin",
          "rate-limited",
          "join-timeout",
          "kicked",
          "room-locked",
          "not-host",
          "not-sharing",
          "chat-rate-limited",
          "unknown-code",
        ),
        message: fc.string({ maxLength: 120 }),
      }),
    );

    fc.assert(
      fc.property(serverMessageArb, (payload) => {
        const res = parseServerMessage(JSON.stringify(payload));
        if (res !== null) {
          expect(validTypes).toContain(res.t);
          if (res.t === "welcome") {
            expect(res.selfId.length).toBeGreaterThan(0);
            expect(res.hostToken).not.toBe("");
            expect(res.rejoinToken).not.toBe("");
            expect(res.password).not.toBe("");
          } else if (res.t === "chat") {
            expect(res.id.length).toBeGreaterThanOrEqual(1);
            expect(res.id.length).toBeLessThanOrEqual(64);
            expect(res.from.length).toBeGreaterThanOrEqual(1);
            expect(res.name.length).toBeLessThanOrEqual(32);
            expect(res.text.length).toBeGreaterThanOrEqual(1);
            expect(res.text.length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
            expect(Number.isFinite(res.ts)).toBe(true);
          }
        }
        return true;
      }),
      { numRuns: 700 },
    );
  });

  it("parseInviteInput never throws and handles arbitrary and structured invites/URLs", () => {
    const validReasons = ["empty", "url-missing-invite", "missing-secret", "invalid"];
    const alphabetChars = ROOM_CODE_ALPHABET.split("");
    const codeArb = fc
      .array(fc.constantFrom(...alphabetChars), { minLength: ROOM_CODE_LENGTH, maxLength: ROOM_CODE_LENGTH })
      .map((chars) => chars.join(""));
    const passArb = fc
      .array(fc.constantFrom(...alphabetChars), {
        minLength: ROOM_PASSWORD_LENGTH,
        maxLength: ROOM_PASSWORD_LENGTH,
      })
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(fc.string(), (raw) => {
        const res = parseInviteInput(raw);
        if (res.ok) {
          expect(isValidRoomCode(res.code)).toBe(true);
          expect(isValidRoomPassword(res.password)).toBe(true);
        } else {
          expect(validReasons).toContain(res.reason);
        }
        return true;
      }),
      { numRuns: 500 },
    );

    fc.assert(
      fc.property(
        codeArb,
        passArb,
        fc.constantFrom("-", ".", "%2D", ""),
        fc.constantFrom("", "#", "/#", "https://example.com/#", "https://sub-domain.example.com/r#"),
        fc.boolean(),
        fc.boolean(),
        (code, password, sep, prefix, lowercase, padSpace) => {
          const body = `${code}${sep}${password}`;
          const formattedBody = lowercase ? body.toLowerCase() : body;
          const raw = padSpace ? `  ${prefix}${formattedBody}  ` : `${prefix}${formattedBody}`;
          // "%2D" only decodes after "#" (URL/hash inputs); bare strings keep "%2D" literal and reject as invalid.
          const expectsOk = sep !== "%2D" || prefix.includes("#");
          const res = parseInviteInput(raw);
          if (expectsOk) {
            expect(res).toEqual({ ok: true, code, password });
          } else {
            expect(res.ok).toBe(false);
          }
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });
});
