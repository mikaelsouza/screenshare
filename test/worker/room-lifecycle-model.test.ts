import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LiveClient,
  activeCount,
  assertRoomDoInvariants,
  currentHost,
  initModelRoom,
  recordStalePassword,
  syncGuestRotationTickets,
  waitSocketCount,
  type RoomModelState,
} from "./room-lifecycle-model-helpers";

type ModelOp =
  | { kind: "join-creator" }
  | { kind: "join-guest" }
  | { kind: "disconnect-creator" }
  | { kind: "disconnect-guest" }
  | { kind: "resume-ticket" }
  | { kind: "toggle-lock" }
  | { kind: "rotate-password" }
  | { kind: "kick-guest" }
  | { kind: "relay-check" }
  | { kind: "stale-password-check" }
  | { kind: "kicked-ip-check" }
  | { kind: "alarm"; ageMs: number };

async function runJoinCreator(state: RoomModelState): Promise<void> {
  if (state.creator) return;
  const ip = `198.51.101.${state.ipSeq++}`;
  const c = await LiveClient.connect(state.code, ip);
  c.send({ t: "join", room: state.code, displayName: "creator", hostToken: state.creatorToken });
  if (state.hostPromoted) {
    expect((await c.nextOf("error")).code).toBe("bad-password");
    c.close();
    await waitSocketCount(state.stub, activeCount(state));
    return;
  }
  const w = await c.nextOf("welcome");
  expect(w.host).toBe(true);
  if (w.password) state.password = w.password;
  if (state.disconnectedTicket?.host) state.disconnectedTicket = null;
  state.creator = {
    client: c,
    id: w.selfId,
    ip,
    rejoinToken: w.rejoinToken ?? "",
    sharing: false,
    host: true,
  };
}

async function runJoinGuest(state: RoomModelState): Promise<void> {
  if (state.guests.length >= 3) return;
  const ip = `198.51.101.${state.ipSeq++}`;
  const c = await LiveClient.connect(state.code, ip);
  c.send({ t: "join", room: state.code, displayName: "guest", password: state.password });
  if (state.locked) {
    expect((await c.nextOf("error")).code).toBe("room-locked");
    c.close();
    await waitSocketCount(state.stub, activeCount(state));
    return;
  }
  const w = await c.nextOf("welcome");
  expect(w.host).toBe(false);
  state.guests.push({
    client: c,
    id: w.selfId,
    ip,
    rejoinToken: w.rejoinToken ?? "",
    sharing: false,
    host: false,
  });
}

async function runResumeTicket(state: RoomModelState): Promise<void> {
  if (!state.disconnectedTicket) return;
  const ticket = state.disconnectedTicket;
  state.disconnectedTicket = null;
  const c = await LiveClient.connect(state.code, ticket.ip);
  c.send({ t: "join", room: state.code, displayName: "guest-resumed", rejoinToken: ticket.rejoinToken, resume: true });
  const w = await c.nextOf("welcome");
  expect(w.selfId).toBe(ticket.id);
  state.guests.push({
    client: c,
    id: w.selfId,
    ip: ticket.ip,
    rejoinToken: w.rejoinToken ?? "",
    sharing: false,
    host: w.host,
  });
}

async function runHostAction(
  state: RoomModelState,
  kind: "toggle-lock" | "rotate-password" | "kick-guest",
): Promise<void> {
  const host = currentHost(state);
  if (!host) return;
  if (kind === "toggle-lock") {
    const nextLocked = !state.locked;
    host.client.send({ t: "lock", locked: nextLocked });
    const msg = await host.client.nextOf("room-state");
    expect(msg.locked).toBe(nextLocked);
    state.locked = nextLocked;
    return;
  }
  if (kind === "rotate-password") {
    host.client.send({ t: "rotate-password" });
    const rot = await host.client.nextOf("room-password");
    if (rot.password) {
      recordStalePassword(state, state.password);
      state.password = rot.password;
    }
    await syncGuestRotationTickets(state.guests, host.id);
    state.disconnectedTicket = null;
    return;
  }
  const targetIdx = state.guests.findIndex((g) => g.id !== host.id);
  if (targetIdx === -1) return;
  const [target] = state.guests.splice(targetIdx, 1);
  if (!target) return;
  host.client.send({ t: "kick", id: target.id });
  expect((await target.client.nextOf("error")).code).toBe("kicked");
  target.client.close();
  const rot = await host.client.nextOf("room-password");
  if (rot.password) {
    recordStalePassword(state, state.password);
    state.password = rot.password;
  }
  await syncGuestRotationTickets(state.guests, host.id);
  state.kickedIps.push(target.ip);
  state.disconnectedTicket = null;
  await waitSocketCount(state.stub, activeCount(state));
}

async function runRelayCheck(state: RoomModelState): Promise<void> {
  const peers = [...(state.creator ? [state.creator] : []), ...state.guests];
  const sender = peers[0];
  const receiver = peers[1];
  if (!sender || !receiver) return;

  sender.client.send({ t: "signal", to: receiver.id, data: { k: "offer", sdp: "v=0\r\n" } });
  expect((await sender.client.nextOf("error")).code).toBe("not-sharing");

  sender.client.send({ t: "state", sharing: true });
  const sharedState = await receiver.client.nextOf("peer-state");
  expect(sharedState.id).toBe(sender.id);
  expect(sharedState.sharing).toBe(true);

  sender.client.send({ t: "signal", to: receiver.id, data: { k: "offer", sdp: "v=0\r\n" } });
  const relayed = await receiver.client.nextOf("signal");
  expect(relayed.from).toBe(sender.id);

  sender.client.send({ t: "state", sharing: false });
  const unsharedState = await receiver.client.nextOf("peer-state");
  expect(unsharedState.id).toBe(sender.id);
  expect(unsharedState.sharing).toBe(false);

  sender.client.send({ t: "signal", to: receiver.id, data: { k: "offer", sdp: "v=0\r\n" } });
  expect((await sender.client.nextOf("error")).code).toBe("not-sharing");
}

async function runSecurityCheck(
  state: RoomModelState,
  kind: "stale-password-check" | "kicked-ip-check",
): Promise<void> {
  if (state.locked) return;
  if (kind === "stale-password-check") {
    const stalePw = state.stalePasswords[state.stalePasswords.length - 1];
    if (!stalePw) return;
    const c = await LiveClient.connect(state.code, `198.51.101.${state.ipSeq++}`);
    c.send({ t: "join", room: state.code, displayName: "stale", password: stalePw });
    expect((await c.nextOf("error")).code).toBe("bad-password");
    c.close();
    await waitSocketCount(state.stub, activeCount(state));
    return;
  }
  const bannedIp = state.kickedIps[0];
  if (bannedIp) {
    const c = await LiveClient.connect(state.code, bannedIp);
    c.send({ t: "join", room: state.code, displayName: "banned", password: state.password });
    expect((await c.nextOf("error")).code).toBe("kicked");
    c.close();
    await waitSocketCount(state.stub, activeCount(state));
    return;
  }
  if (state.guests.length >= 3) return;
  const unbannedIp = state.unbannedIps.shift();
  if (!unbannedIp) return;
  const c = await LiveClient.connect(state.code, unbannedIp);
  c.send({ t: "join", room: state.code, displayName: "unbanned", password: state.password });
  const w = await c.nextOf("welcome");
  expect(w.host).toBe(false);
  state.guests.push({
    client: c,
    id: w.selfId,
    ip: unbannedIp,
    rejoinToken: w.rejoinToken ?? "",
    sharing: false,
    host: false,
  });
}

async function runAlarmOp(state: RoomModelState, ageMs: number): Promise<void> {
  const empty = activeCount(state) === 0;
  const wasHostlessOccupied = !empty && !state.creator && !state.guests.some((g) => g.host);
  await runInDurableObject(state.stub, async (_i, storageObj) => {
    const s = storageObj.storage;
    if (ageMs >= 91 * 86_400_000) {
      await s.put("lastHostActiveAt", Date.now() - ageMs);
      if (empty) await s.put("emptySince", Date.now() - ageMs);
    } else if (empty) {
      await s.put("emptySince", Date.now() - ageMs);
    } else if (wasHostlessOccupied) {
      await s.put("hostGoneAt", Date.now() - ageMs);
    }
  });
  await runDurableObjectAlarm(state.stub);
  if (ageMs >= 91 * 86_400_000 && !state.creator) {
    expect(await runInDurableObject(state.stub, async (_i, s) => (await s.storage.list()).size)).toBe(0);
    state.expired = true;
    for (const g of state.guests) g.client.close();
    state.guests = [];
    state.kickedIps = [];
    state.unbannedIps = [];
    return;
  }
  if (wasHostlessOccupied && ageMs >= 5 * 60_000 && state.guests.length > 0) {
    const promotedId = await runInDurableObject(state.stub, (_i, s) => {
      for (const ws of s.getWebSockets()) {
        const att = ws.deserializeAttachment() as { id?: string; joined?: boolean; host?: boolean } | null;
        if (att?.joined && att.host) return att.id;
      }
      return undefined;
    });
    const candidate = state.guests.find((g) => g.id === promotedId);
    expect(candidate).toBeDefined();
    let promo = await candidate!.client.nextOf("host-promoted");
    while (promo.hostToken === undefined) promo = await candidate!.client.nextOf("host-promoted");
    expect(promo.hostId).toBe(candidate!.id);
    candidate!.host = true;
    state.hostPromoted = true;
    return;
  }
  if (empty && ageMs >= 16 * 60_000) {
    const prevLocked = state.locked;
    const prevPassword = state.password;
    state.disconnectedTicket = null;
    state.locked = false;
    state.hostPromoted = false;
    state.unbannedIps.push(...state.kickedIps);
    state.kickedIps = [];
    const persistedPw = await runInDurableObject(state.stub, (_i, s) => s.storage.get<string>("roomPassword"));
    if (prevLocked) {
      expect(persistedPw).toBeDefined();
      expect(persistedPw).not.toBe(prevPassword);
      recordStalePassword(state, prevPassword);
    }
    if (persistedPw) state.password = persistedPw;
  }
}

async function applyOp(state: RoomModelState, op: ModelOp): Promise<void> {
  if (op.kind === "join-creator") return runJoinCreator(state);
  if (op.kind === "join-guest") return runJoinGuest(state);
  if (op.kind === "disconnect-creator" && state.creator) {
    state.creator.client.close();
    state.creator = null;
    return waitSocketCount(state.stub, activeCount(state));
  }
  if (op.kind === "disconnect-guest" && state.guests.length > 0) {
    const g = state.guests.shift()!;
    state.disconnectedTicket = { id: g.id, ip: g.ip, rejoinToken: g.rejoinToken, host: g.host };
    g.client.close();
    return waitSocketCount(state.stub, activeCount(state));
  }
  if (op.kind === "resume-ticket") return runResumeTicket(state);
  if (op.kind === "toggle-lock" || op.kind === "rotate-password" || op.kind === "kick-guest") {
    return runHostAction(state, op.kind);
  }
  if (op.kind === "relay-check") return runRelayCheck(state);
  if (op.kind === "stale-password-check" || op.kind === "kicked-ip-check") return runSecurityCheck(state, op.kind);
  if (op.kind === "alarm") return runAlarmOp(state, op.ageMs);
}

describe("RoomDO stateful model (real workerd execution)", () => {
  it("preserves host authority, partial-mesh relay, lock/rotation, and 15m/90d lifecycle invariants", async () => {
    const opsArb = fc.array(
      fc.oneof(
        fc.constant({ kind: "join-creator" } as const),
        fc.constant({ kind: "join-guest" } as const),
        fc.constant({ kind: "disconnect-creator" } as const),
        fc.constant({ kind: "disconnect-guest" } as const),
        fc.constant({ kind: "resume-ticket" } as const),
        fc.constant({ kind: "toggle-lock" } as const),
        fc.constant({ kind: "rotate-password" } as const),
        fc.constant({ kind: "kick-guest" } as const),
        fc.constant({ kind: "relay-check" } as const),
        fc.constant({ kind: "stale-password-check" } as const),
        fc.constant({ kind: "kicked-ip-check" } as const),
        fc.constantFrom(
          { kind: "alarm", ageMs: 6 * 60_000 } as const,
          { kind: "alarm", ageMs: 16 * 60_000 } as const,
          { kind: "alarm", ageMs: 91 * 86_400_000 } as const,
        ),
      ),
      { minLength: 4, maxLength: 14 },
    );

    let totalRuns = 0;
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        totalRuns += 1;
        const { code, stub, created } = await initModelRoom();
        const state: RoomModelState = {
          code,
          stub,
          password: created.password,
          creatorToken: created.hostToken,
          locked: false,
          expired: false,
          hostPromoted: false,
          creator: null,
          guests: [],
          disconnectedTicket: null,
          stalePasswords: [],
          kickedIps: [],
          unbannedIps: [],
          ipSeq: 1,
        };

        try {
          for (const op of ops) {
            if (state.expired) break;
            await applyOp(state, op);
            await assertRoomDoInvariants(stub, state);
          }
        } finally {
          state.creator?.client.close();
          for (const g of state.guests) g.client.close();
          await waitSocketCount(stub, 0);
        }
      }),
      { numRuns: 15 },
    );
    expect(totalRuns).toBe(15);
  }, 15_000);

  it("blocks creator token while guest is promoted host until 15m empty cleanup restores creator authority", async () => {
    const { code, stub, created } = await initModelRoom();
    const guest = await LiveClient.connect(code, "198.51.101.201");
    guest.send({ t: "join", room: code, displayName: "guest", password: created.password });
    const gw = await guest.nextOf("welcome");
    expect(gw.host).toBe(false);

    await runInDurableObject(stub, (_i, s) => s.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    await runDurableObjectAlarm(stub);
    expect((await guest.nextOf("host-promoted")).hostId).toBe(gw.selfId);

    const refusedCreator = await LiveClient.connect(code, "198.51.101.202");
    refusedCreator.send({ t: "join", room: code, displayName: "creator", hostToken: created.hostToken });
    expect((await refusedCreator.nextOf("error")).code).toBe("bad-password");
    refusedCreator.close();
    guest.close();
    await waitSocketCount(stub, 0);

    await runInDurableObject(stub, (_i, s) => s.storage.put("emptySince", Date.now() - 16 * 60_000));
    await runDurableObjectAlarm(stub);

    const creator = await LiveClient.connect(code, "198.51.101.203");
    creator.send({ t: "join", room: code, displayName: "creator", hostToken: created.hostToken });
    expect((await creator.nextOf("welcome")).host).toBe(true);
    creator.close();
    await waitSocketCount(stub, 0);
  });

  it("ignores queued peer host-promoted broadcasts when a second guest is promoted after the first disconnects", async () => {
    const { code, stub, created } = await initModelRoom();
    const g1 = await LiveClient.connect(code, "198.51.101.211");
    g1.send({ t: "join", room: code, displayName: "g1", password: created.password });
    const w1 = await g1.nextOf("welcome");

    const g2 = await LiveClient.connect(code, "198.51.101.212");
    g2.send({ t: "join", room: code, displayName: "g2", password: created.password });
    const w2 = await g2.nextOf("welcome");

    await runInDurableObject(stub, (_i, s) => s.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    await runDurableObjectAlarm(stub);

    const firstHostId = await runInDurableObject(stub, (_i, s) => {
      for (const ws of s.getWebSockets()) {
        const att = ws.deserializeAttachment() as { id?: string; joined?: boolean; host?: boolean } | null;
        if (att?.joined && att.host) return att.id;
      }
      return undefined;
    });
    const first = firstHostId === w1.selfId ? { id: w1.selfId, client: g1 } : { id: w2.selfId, client: g2 };
    const second = firstHostId === w1.selfId ? { id: w2.selfId, client: g2 } : { id: w1.selfId, client: g1 };
    expect((await first.client.nextOf("host-promoted")).hostToken).toBeTruthy();

    first.client.close();
    await waitSocketCount(stub, 1);

    await runInDurableObject(stub, (_i, s) => s.storage.put("hostGoneAt", Date.now() - 6 * 60_000));
    await runDurableObjectAlarm(stub);

    let promo = await second.client.nextOf("host-promoted");
    while (promo.hostToken === undefined) promo = await second.client.nextOf("host-promoted");
    expect(promo.hostId).toBe(second.id);

    second.client.close();
    await waitSocketCount(stub, 0);
  });

  it("reconciles overdue 15m locked-room cleanup and 90d expiry lazily before admit without running alarm", async () => {
    const lockedRoom = await initModelRoom();
    const creator = await LiveClient.connect(lockedRoom.code, "198.51.101.221");
    creator.send({ t: "join", room: lockedRoom.code, displayName: "creator", hostToken: lockedRoom.created.hostToken });
    await creator.nextOf("welcome");
    creator.send({ t: "lock", locked: true });
    expect((await creator.nextOf("room-state")).locked).toBe(true);
    creator.close();
    await waitSocketCount(lockedRoom.stub, 0);

    await runInDurableObject(lockedRoom.stub, (_i, s) => s.storage.put("emptySince", Date.now() - 16 * 60_000));

    const staleGuest = await LiveClient.connect(lockedRoom.code, "198.51.101.222");
    staleGuest.send({ t: "join", room: lockedRoom.code, displayName: "stale", password: lockedRoom.created.password });
    expect((await staleGuest.nextOf("error")).code).toBe("bad-password");
    staleGuest.close();
    await waitSocketCount(lockedRoom.stub, 0);

    const unlocked = await runInDurableObject(lockedRoom.stub, async (_i, s) => ({
      locked: await s.storage.get<boolean>("locked"),
      pw: await s.storage.get<string>("roomPassword"),
    }));
    expect(unlocked.locked).toBe(false);
    expect(unlocked.pw).toBeDefined();
    expect(unlocked.pw).not.toBe(lockedRoom.created.password);

    const expiredRoom = await initModelRoom();
    const g = await LiveClient.connect(expiredRoom.code, "198.51.101.223");
    g.send({ t: "join", room: expiredRoom.code, displayName: "guest", password: expiredRoom.created.password });
    await g.nextOf("welcome");
    g.close();
    await waitSocketCount(expiredRoom.stub, 0);

    await runInDurableObject(expiredRoom.stub, async (_i, s) => {
      const old = Date.now() - 91 * 86_400_000;
      await s.storage.put({ emptySince: old, lastHostActiveAt: old });
    });

    const lateJoin = await LiveClient.connect(expiredRoom.code, "198.51.101.224");
    lateJoin.send({ t: "join", room: expiredRoom.code, displayName: "late", password: expiredRoom.created.password });
    expect((await lateJoin.nextOf("error")).code).toBe("bad-password");
    lateJoin.close();
    await waitSocketCount(expiredRoom.stub, 0);
    expect(await runInDurableObject(expiredRoom.stub, async (_i, s) => (await s.storage.list()).size)).toBe(0);
  });
});
