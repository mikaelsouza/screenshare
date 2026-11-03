import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseClientMessage,
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
          expect(["join", "signal", "state", "kick", "lock"]).toContain(result.t);
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
      expect((Object.prototype as any).polluted).toBeUndefined();
      expect((Object.prototype as any).isAdmin).toBeUndefined();
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
          expect((Object.prototype as any)[key]).toBeUndefined();
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });

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

        // Invariants on valid messages:
        if (result.t === "join") {
          expect(typeof result.room).toBe("string");
          expect(typeof result.displayName).toBe("string");
          if (result.password !== undefined) expect(typeof result.password).toBe("string");
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
        } else if (result.t === "signal") {
          expect(PEER_ID_REGEX.test(result.to)).toBe(true);
          expect(typeof result.data).toBe("object");
          expect(["offer", "answer", "ice"]).toContain(result.data.k);

          if (result.data.k === "offer" || result.data.k === "answer") {
            expect(typeof result.data.sdp).toBe("string");
            expect(result.data.sdp.length).toBeLessThanOrEqual(MAX_SDP_LENGTH);
          } else if (result.data.k === "ice") {
            // Feature 45: Candidate structural invariants
            expect(typeof result.data.candidate.candidate).toBe("string");
            expect(result.data.candidate.candidate.length).toBeLessThanOrEqual(MAX_CANDIDATE_LENGTH);
            const mid = result.data.candidate.sdpMid;
            expect(typeof mid === "string" || mid === null).toBe(true);
            const mline = result.data.candidate.sdpMLineIndex;
            expect(typeof mline === "number" || mline === null).toBe(true);
          }
        } else if (result.t === "state") {
          expect(typeof result.sharing).toBe("boolean");
        } else if (result.t === "kick") {
          expect(PEER_ID_REGEX.test(result.id)).toBe(true);
        } else if (result.t === "lock") {
          expect(typeof result.locked).toBe("boolean");
        }
        return true;
      }),
      { numRuns: 1000 }
    );
  });
});
