import { describe, expect, it } from "vitest";
import type { ChatMessage, PeerId } from "@shared/protocol";
import {
  ChatController,
  formatChatTime,
  MAX_CHAT_MESSAGES,
  type ChatEntry,
} from "@src/controllers/chat-controller";

function makeMsg(overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg-1",
    from: "abcdef12-3456-7890-abcd-ef1234567890",
    name: "Alice",
    text: "Hello room",
    ts: new Date(2026, 0, 1, 12, 34, 0, 0).getTime(),
    ...overrides,
  };
}

describe("formatChatTime", () => {
  it("formats local hours and minutes with zero-padding", () => {
    expect(formatChatTime(new Date(2026, 0, 1, 0, 0, 0, 0).getTime())).toBe("00:00");
    expect(formatChatTime(new Date(2026, 0, 1, 0, 5, 0, 0).getTime())).toBe("00:05");
    expect(formatChatTime(new Date(2026, 0, 1, 9, 9, 0, 0).getTime())).toBe("09:09");
    expect(formatChatTime(new Date(2026, 0, 1, 14, 30, 0, 0).getTime())).toBe("14:30");
    expect(formatChatTime(new Date(2026, 0, 1, 23, 59, 0, 0).getTime())).toBe("23:59");
  });

  it("returns --:-- for invalid or non-finite timestamps", () => {
    expect(formatChatTime(Number.NaN)).toBe("--:--");
    expect(formatChatTime(Number.POSITIVE_INFINITY)).toBe("--:--");
    expect(formatChatTime(Number.NEGATIVE_INFINITY)).toBe("--:--");
    expect(formatChatTime(9e15)).toBe("--:--");
  });
});

describe("ChatController", () => {
  it("starts empty, closed, and with zero unread messages", () => {
    expect(MAX_CHAT_MESSAGES).toBe(200);
    const ctrl = new ChatController();
    expect(ctrl.open).toBe(false);
    expect(ctrl.messages).toEqual([]);
    expect(ctrl.unreadCount).toBe(0);
    expect(ctrl.seenIds.size).toBe(0);
    expect(ctrl.unreadLabel()).toBe("");
  });

  it("derives ChatEntry fields, trims names, falls back to Anonymous, and attributes self", () => {
    const ctrl = new ChatController();
    const selfId: PeerId = "abcdef12-3456-7890-abcd-ef1234567890";

    const e1: ChatEntry | null = ctrl.receive(
      makeMsg({
        id: "id-1",
        from: selfId,
        name: "  Alice  ",
        text: "Hi there",
        ts: 1_700_000_000_000,
      }),
      selfId,
    );
    expect(e1).toEqual({
      id: "id-1",
      from: selfId,
      shortId: "#abcd",
      name: "Alice",
      text: "Hi there",
      ts: 1_700_000_000_000,
      self: true,
    });
    expect(ctrl.unreadCount).toBe(0);

    const e2 = ctrl.receive(
      makeMsg({
        id: "id-2",
        from: "p1",
        name: "   ",
        text: "Blank name",
      }),
      null,
    );
    expect(e2?.shortId).toBe("#p1");
    expect(e2?.name).toBe("Anonymous");
    expect(e2?.self).toBe(false);
    expect(ctrl.unreadCount).toBe(1);

    const e3 = ctrl.receive(
      makeMsg({
        id: "id-3",
        from: "99887766-1111-2222-3333-444455556666",
        name: "",
        text: "Empty name",
      }),
      selfId,
    );
    expect(e3?.shortId).toBe("#9988");
    expect(e3?.name).toBe("Anonymous");
    expect(e3?.self).toBe(false);
    expect(ctrl.unreadCount).toBe(2);
    expect(ctrl.messages).toHaveLength(3);
    expect(ctrl.seenIds.has("id-1")).toBe(true);
    expect(ctrl.seenIds.has("id-2")).toBe(true);
    expect(ctrl.seenIds.has("id-3")).toBe(true);
  });

  it("ignores duplicate message IDs without appending or incrementing unread", () => {
    const ctrl = new ChatController();
    const msg = makeMsg({ id: "dup-1", from: "peer-1" });
    expect(ctrl.receive(msg, "self-1")).not.toBeNull();
    expect(ctrl.unreadCount).toBe(1);

    expect(ctrl.receive(msg, "self-1")).toBeNull();
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.unreadCount).toBe(1);
    expect(ctrl.seenIds.size).toBe(1);
  });

  it("increments unreadCount only when !open && !self across all 4 combinations", () => {
    const ctrl = new ChatController();

    // open=false, self=false -> increments
    ctrl.receive(makeMsg({ id: "m1", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(1);

    // open=false, self=true -> unchanged
    ctrl.receive(makeMsg({ id: "m2", from: "self-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(1);

    // setOpen(false) preserves unreadCount
    ctrl.setOpen(false);
    expect(ctrl.open).toBe(false);
    expect(ctrl.unreadCount).toBe(1);

    // setOpen(true) resets unreadCount
    ctrl.setOpen(true);
    expect(ctrl.open).toBe(true);
    expect(ctrl.unreadCount).toBe(0);

    // open=true, self=false -> unchanged
    ctrl.receive(makeMsg({ id: "m3", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(0);

    // open=true, self=true -> unchanged
    ctrl.receive(makeMsg({ id: "m4", from: "self-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(0);
  });

  it("handles setOpen, toggle, and unreadLabel boundaries (0, 1, 99, 100, 101)", () => {
    const ctrl = new ChatController();
    expect(ctrl.unreadLabel()).toBe("");

    ctrl.receive(makeMsg({ id: "u1", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(1);
    expect(ctrl.unreadLabel()).toBe("1");

    for (let i = 2; i <= 99; i++) {
      ctrl.receive(makeMsg({ id: `u${i}`, from: "peer-1" }), "self-1");
    }
    expect(ctrl.unreadCount).toBe(99);
    expect(ctrl.unreadLabel()).toBe("99");

    ctrl.receive(makeMsg({ id: "u100", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(100);
    expect(ctrl.unreadLabel()).toBe("99+");

    ctrl.receive(makeMsg({ id: "u101", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(101);
    expect(ctrl.unreadLabel()).toBe("99+");

    // toggle() false -> true clears unread and returns true
    expect(ctrl.toggle()).toBe(true);
    expect(ctrl.open).toBe(true);
    expect(ctrl.unreadCount).toBe(0);
    expect(ctrl.unreadLabel()).toBe("");

    // setOpen(true) idempotency
    ctrl.setOpen(true);
    expect(ctrl.open).toBe(true);
    expect(ctrl.unreadCount).toBe(0);

    // toggle() true -> false returns false
    expect(ctrl.toggle()).toBe(false);
    expect(ctrl.open).toBe(false);
    ctrl.receive(makeMsg({ id: "u102", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(1);

    // setOpen(false) after closed preserves unread
    ctrl.setOpen(false);
    expect(ctrl.unreadCount).toBe(1);
  });

  it("evicts oldest message and its seenId at MAX_CHAT_MESSAGES (200) and allows re-receipt after eviction", () => {
    const ctrl = new ChatController();
    for (let i = 0; i < MAX_CHAT_MESSAGES; i++) {
      const entry = ctrl.receive(makeMsg({ id: `m${i}`, from: "peer-1" }), "self-1");
      expect(entry?.id).toBe(`m${i}`);
    }

    expect(ctrl.messages).toHaveLength(200);
    expect(ctrl.messages[0]?.id).toBe("m0");
    expect(ctrl.messages[199]?.id).toBe("m199");
    expect(ctrl.seenIds.size).toBe(200);
    expect(ctrl.unreadCount).toBe(200);

    // Duplicate while at capacity must NOT evict m0 or increment unread
    expect(ctrl.receive(makeMsg({ id: "m0", from: "peer-1" }), "self-1")).toBeNull();
    expect(ctrl.messages).toHaveLength(200);
    expect(ctrl.messages[0]?.id).toBe("m0");
    expect(ctrl.unreadCount).toBe(200);

    // 201st message evicts m0 from both messages and seenIds
    const entry200 = ctrl.receive(makeMsg({ id: "m200", from: "peer-1" }), "self-1");
    expect(entry200?.id).toBe("m200");
    expect(ctrl.messages).toHaveLength(200);
    expect(ctrl.messages[0]?.id).toBe("m1");
    expect(ctrl.messages[199]?.id).toBe("m200");
    expect(ctrl.seenIds.size).toBe(200);
    expect(ctrl.seenIds.has("m0")).toBe(false);
    expect(ctrl.seenIds.has("m200")).toBe(true);

    // Evicted ID can be accepted again (and evicts m1)
    const reAccepted = ctrl.receive(makeMsg({ id: "m0", from: "peer-1" }), "self-1");
    expect(reAccepted?.id).toBe("m0");
    expect(ctrl.messages).toHaveLength(200);
    expect(ctrl.messages[0]?.id).toBe("m2");
    expect(ctrl.messages[199]?.id).toBe("m0");
    expect(ctrl.seenIds.has("m1")).toBe(false);
    expect(ctrl.seenIds.has("m0")).toBe(true);
  });

  it("resets messages, seenIds, unreadCount, and open state completely", () => {
    const ctrl = new ChatController();
    ctrl.receive(makeMsg({ id: "r1", from: "peer-1" }), "self-1");
    ctrl.receive(makeMsg({ id: "r2", from: "peer-1" }), "self-1");
    expect(ctrl.unreadCount).toBe(2);

    ctrl.reset();
    expect(ctrl.open).toBe(false);
    expect(ctrl.messages).toEqual([]);
    expect(ctrl.unreadCount).toBe(0);
    expect(ctrl.seenIds.size).toBe(0);
    expect(ctrl.unreadLabel()).toBe("");

    // Reset also clears open=true and seenIds
    ctrl.setOpen(true);
    ctrl.receive(makeMsg({ id: "r3", from: "peer-1" }), "self-1");
    expect(ctrl.open).toBe(true);
    expect(ctrl.seenIds.has("r3")).toBe(true);

    ctrl.reset();
    expect(ctrl.open).toBe(false);
    expect(ctrl.messages).toEqual([]);
    expect(ctrl.unreadCount).toBe(0);
    expect(ctrl.seenIds.size).toBe(0);

    // Previously seen ID is accepted again and increments unread since open was reset to false
    const reReceived = ctrl.receive(makeMsg({ id: "r3", from: "peer-1" }), "self-1");
    expect(reReceived?.id).toBe("r3");
    expect(ctrl.unreadCount).toBe(1);
  });
});
