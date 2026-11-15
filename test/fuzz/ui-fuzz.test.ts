import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeVolumeState,
  deriveOutboundAudioState,
  formatJoinChipText,
  nextPopoverState,
  sortAndFormatRoster,
  type PopoverKind,
} from "@src/ui-model";

describe("Fuzzing Suite: UI Model Volume, Popover & Roster Formatting", () => {
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

  it("nextPopoverState and deriveOutboundAudioState preserve invariants across random action traces", () => {
    const stepArb = fc.record({
      target: fc.constantFrom<PopoverKind | null>(
        null,
        "invite",
        "roster",
        "preset",
        "codec",
        "degradation",
      ),
      connected: fc.boolean(),
      sharing: fc.boolean(),
      hasAudio: fc.boolean(),
      trackEnabled: fc.boolean(),
    });

    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 50 }), (steps) => {
        let current: PopoverKind | null = null;
        for (const step of steps) {
          const pop = nextPopoverState(current, step.target, step.connected, step.sharing);
          const openCount =
            Number(pop.inviteOpen) +
            Number(pop.rosterOpen) +
            Number(pop.presetOpen) +
            Number(pop.codecOpen) +
            Number(pop.degradationOpen);
          expect(openCount).toBeLessThanOrEqual(1);
          if (!step.connected) expect(pop.active).toBeNull();
          if (!step.sharing) {
            expect(pop.presetOpen).toBe(false);
            expect(pop.codecOpen).toBe(false);
            expect(pop.degradationOpen).toBe(false);
          }
          current = pop.active;

          const audio = deriveOutboundAudioState(step.sharing, step.hasAudio, step.trackEnabled);
          expect(audio.disabled && audio.muted).toBe(false);
          expect(audio.ariaPressed).toBe(audio.muted ? "true" : "false");
        }
        return true;
      }),
      { numRuns: 500 },
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
          for (const peer of peerList) {
            if (peer.id !== selfId) {
              map.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host });
            }
          }

          const res = sortAndFormatRoster(selfId, selfName, selfSharing, isHost, roomLocked, map);
          expect(res.totalCount).toBe(map.size + 1);
          expect(res.entries).toHaveLength(map.size + 1);
          expect(res.entries[0]?.self).toBe(true);
          expect(res.entries[0]?.id).toBe(selfId);
          expect(res.entries[0]?.canKick).toBe(false);

          for (const entry of res.entries.slice(1)) {
            expect(entry.self).toBe(false);
            expect(entry.canKick).toBe(isHost);
            expect(entry.name.length).toBeGreaterThan(0);
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

  it("sortAndFormatRoster preserves invariants when newPeerIds and extraPeerIds options are supplied", () => {
    const peerArb = fc.record({
      id: fc.uuid(),
      name: fc.string({ maxLength: 40 }),
      sharing: fc.boolean(),
      host: fc.boolean(),
    });

    fc.assert(
      fc.property(
        fc.uuid(),
        fc.string({ maxLength: 40 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.array(peerArb, { maxLength: 15 }),
        fc.array(fc.uuid(), { maxLength: 10 }),
        fc.array(fc.uuid(), { maxLength: 10 }),
        (selfId, selfName, selfSharing, isHost, roomLocked, peerList, newIds, extraIds) => {
          const map = new Map<string, { name: string; sharing: boolean; host: boolean }>();
          for (const peer of peerList) {
            if (peer.id !== selfId) {
              map.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host });
            }
          }
          const newPeerIds = new Set<string>([selfId, ...newIds]);
          const extraPeerIds = [selfId, ...extraIds];

          const expectedIds = new Set<string>(map.keys());
          for (const id of extraPeerIds) {
            if (id !== selfId) expectedIds.add(id);
          }

          const res = sortAndFormatRoster(selfId, selfName, selfSharing, isHost, roomLocked, map, {
            newPeerIds,
            extraPeerIds,
          });

          expect(res.totalCount).toBe(expectedIds.size + 1);
          expect(res.entries[0]?.self).toBe(true);
          expect(res.entries[0]?.isNew).toBe(false);

          for (const entry of res.entries.slice(1)) {
            expect(entry.isNew).toBe(newPeerIds.has(entry.id));
            if (!map.has(entry.id)) {
              expect(entry.name).toBe("Peer");
              expect(entry.sharing).toBe(false);
              expect(entry.host).toBe(false);
            }
          }
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });

  it("formatJoinChipText handles 0, 1, 2, and N arrivals consistently", () => {
    const arrivalArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 32 }),
      shortId: fc.stringMatching(/^#?[0-9a-f]{4}$/),
    });

    fc.assert(
      fc.property(fc.array(arrivalArb, { maxLength: 12 }), (arrivals) => {
        const text = formatJoinChipText(arrivals);
        const [first, second] = arrivals;
        if (!first) {
          expect(text).toBe("");
        } else if (!second) {
          expect(text).toBe(`${first.name} #${first.shortId.replace(/^#/, "")} joined`);
        } else if (arrivals.length === 2) {
          expect(text).toBe(
            `${first.name} #${first.shortId.replace(/^#/, "")} & ${second.name} #${second.shortId.replace(/^#/, "")} joined`,
          );
        } else {
          expect(text).toBe(
            `${first.name} #${first.shortId.replace(/^#/, "")} + ${arrivals.length - 1} others joined`,
          );
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });
});
