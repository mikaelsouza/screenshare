import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeVolumeState,
  sortAndFormatRoster,
} from "@src/ui-model";

describe("Fuzzing Suite: UI Model Volume & Roster Formatting", () => {
  it("computeVolumeState never produces NaN, out-of-range volume, or inconsistent flags", () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), (sliderValue, fallback) => {
        const res = computeVolumeState(sliderValue, fallback);
        if (Number.isFinite(sliderValue) || Number.isFinite(fallback)) {
          expect(Number.isFinite(res.volume)).toBe(true);
          expect(res.volume).toBeGreaterThanOrEqual(0);
          expect(res.volume).toBeLessThanOrEqual(2);
          expect(res.muted).toBe(res.volume === 0);
          expect(res.boosted).toBe(res.volume > 1);
          expect(res.label).toMatch(/^Volume: \d+%$/);
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("sortAndFormatRoster preserves member count, keeps self first, and never fluctuates with bitrate", () => {
    const peerArb = fc.record({
      id: fc.uuid(),
      name: fc.string({ maxLength: 60 }),
      sharing: fc.boolean(),
      host: fc.boolean(),
    });

    fc.assert(
      fc.property(
        fc.uuid(),
        fc.string({ maxLength: 60 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.array(peerArb, { maxLength: 25 }),
        (selfId, selfName, selfSharing, isHost, roomLocked, peerList) => {
          const map = new Map<string, { name: string; sharing: boolean; host: boolean }>();
          for (const p of peerList) {
            if (p.id !== selfId) {
              map.set(p.id, { name: p.name, sharing: p.sharing, host: p.host });
            }
          }

          const res = sortAndFormatRoster(selfId, selfName, selfSharing, isHost, roomLocked, map);
          expect(res.totalCount).toBe(map.size + 1);
          expect(res.entries).toHaveLength(map.size + 1);
          expect(res.entries[0]?.self).toBe(true);
          expect(res.entries[0]?.id).toBe(selfId);
          expect(res.entries[0]?.canKick).toBe(false);

          for (let i = 1; i < res.entries.length; i++) {
            const e = res.entries[i]!;
            expect(e.self).toBe(false);
            expect(e.canKick).toBe(isHost);
            expect(e.name.length).toBeGreaterThan(0);
          }

          expect(res.buttonLabel).toContain(`${res.totalCount} in room · ${res.sharingCount} sharing`);
          expect(res.buttonLabel).not.toContain("Mbps");
          if (roomLocked) {
            expect(res.buttonLabel).toContain("· Locked");
          } else {
            expect(res.buttonLabel).not.toContain("· Locked");
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});
