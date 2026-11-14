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
          expect(["join", "signal", "state", "kick", "lock", "rotate-password", "rename"]).toContain(
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
        else {
          expect(typeof result.displayName).toBe("string");
          expect(result.displayName.length).toBeLessThanOrEqual(128);
        }

        return true;
      }),
      { numRuns: 1000 },
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

    const serverMessageArb = fc.oneof(
      fc.jsonValue(),
      fc.record({
        t: fc.constantFrom(...validTypes, "unknown"),
        selfId: fc.string(),
        id: fc.string(),
        from: fc.string(),
        locked: fc.boolean(),
        sharing: fc.boolean(),
        code: fc.constantFrom(
          "room-full",
          "bad-message",
          "bad-password",
          "session-replaced",
          "invalid-code",
        ),
        message: fc.string(),
      }),
    );

    fc.assert(
      fc.property(serverMessageArb, (payload) => {
        const res = parseServerMessage(JSON.stringify(payload));
        if (res !== null) {
          expect(validTypes).toContain(res.t);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("parseInviteInput never throws and always produces valid credentials or a known failure reason", () => {
    const validReasons = ["empty", "url-missing-invite", "missing-secret", "invalid"];
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
  });
});
