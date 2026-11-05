import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseControlMessage } from "@src/mesh";

describe("Fuzzing Suite: Control Channel Parser (Feature 44)", () => {
  /**
   * Feature 44: Fuzz: Control Channel Parser
   * Invariants:
   * 1. Never throws on arbitrary types or inputs.
   * 2. Rejects any string longer than 256 bytes.
   * 3. Accepts only valid { c: "view", want: boolean }.
   * 4. Rejects non-boolean `want` (no loose type coercion).
   */
  it("never throws on arbitrary input types or unicode", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const parsed = (): ReturnType<typeof parseControlMessage> => parseControlMessage(input);
        expect(parsed).not.toThrow();
        const result = parsed();

        if (result !== null) {
          expect(result).toHaveProperty("c", "view");
          expect(typeof result.want).toBe("boolean");
        }
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("strictly enforces 256-byte payload ceiling", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 257, maxLength: 5000 }), (oversized) => {
        expect(parseControlMessage(oversized)).toBeNull();
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it("strictly rejects loose or truthy non-boolean `want` fields", () => {
    const invalidWants = [1, 0, "true", "false", null, undefined, {}, [], NaN];

    for (const val of invalidWants) {
      const serialized = JSON.stringify({ c: "view", want: val });
      expect(parseControlMessage(serialized)).toBeNull();
    }

    fc.assert(
      fc.property(
        fc.anything().filter((v) => typeof v !== "boolean"),
        (nonBool) => {
          const serialized = JSON.stringify({ c: "view", want: nonBool });
          if (serialized.length <= 256) {
            expect(parseControlMessage(serialized)).toBeNull();
          }
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });

  it("strictly parses valid view control payloads", () => {
    fc.assert(
      fc.property(fc.boolean(), (want) => {
        const valid = JSON.stringify({ c: "view", want });
        expect(parseControlMessage(valid)).toEqual({ c: "view", want });
        return true;
      }),
      { numRuns: 100 }
    );
  });
});
