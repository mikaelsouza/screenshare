import { describe, expect, it, vi } from "vitest";
import { MAX_CHAT_LENGTH, type ServerMessage } from "@shared/protocol";
import type { PeerAttachment } from "@worker/room-models";
import {
  CHAT_BURST,
  CHAT_REFILL_PER_SEC,
  RoomChatRelay,
  sanitiseChatText,
  type ChatRelayHost,
} from "@worker/room-chat";

function makePeer(id: string, name: string, joined = true): {
  ws: WebSocket;
  att: PeerAttachment;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const ws = {
    send: vi.fn((raw: string) => {
      sent.push(JSON.parse(raw) as ServerMessage);
    }),
  } as unknown as WebSocket;
  const att: PeerAttachment = { id, name, sharing: false, joined };
  return { ws, att, sent };
}

function makeHost(peers: Array<{ ws: WebSocket; att: PeerAttachment }>): ChatRelayHost {
  return {
    joinedPeers: () => peers,
  };
}

describe("sanitiseChatText", () => {
  it("strips control, line/paragraph separator, and bidi override characters before collapsing whitespace", () => {
    const raw =
      "hello\u0000\u0007\u001F\u007F\u009F\n\r\t" +
      "world\u2028next\u2029line" +
      "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069!";
    expect(sanitiseChatText(raw)).toBe("helloworldnextline!");
  });

  it("preserves compound emojis (ZWJ and variation selectors) and avoids NFKC folding", () => {
    expect(sanitiseChatText("👨‍👩‍👧‍👦 🏳️‍🌈 ❤️ 1️⃣ 2² ½")).toBe("👨‍👩‍👧‍👦 🏳️‍🌈 ❤️ 1️⃣ 2² ½");
  });

  it("collapses whitespace runs, trims, and returns empty string for blank or control-only input", () => {
    expect(sanitiseChatText("   hello   world  ")).toBe("hello world");
    expect(sanitiseChatText("   \t  \n  ")).toBe("");
    expect(sanitiseChatText("\u0007\u202E\u2066")).toBe("");
  });

  it("clamps to MAX_CHAT_LENGTH without splitting surrogate pairs or leaving trailing spaces", () => {
    const exact = "a".repeat(MAX_CHAT_LENGTH);
    expect(sanitiseChatText(exact)).toBe(exact);

    const overBmp = "a".repeat(MAX_CHAT_LENGTH + 5);
    expect(sanitiseChatText(overBmp)).toHaveLength(MAX_CHAT_LENGTH);

    // Index 499 would be the high surrogate of 😀 (2 UTF-16 code units)
    const boundarySurrogate = "a".repeat(MAX_CHAT_LENGTH - 1) + "😀";
    const clampedBoundary = sanitiseChatText(boundarySurrogate);
    expect(clampedBoundary).toHaveLength(MAX_CHAT_LENGTH - 1);
    expect(clampedBoundary).toBe("a".repeat(MAX_CHAT_LENGTH - 1));

    // Many emojis: 251 * 2 = 502 code units -> clamped to 500 (250 emojis)
    const manyEmojis = "😀".repeat(251);
    expect(sanitiseChatText(manyEmojis)).toHaveLength(MAX_CHAT_LENGTH);

    // Space right before surrogate at boundary -> trailing space trimmed after slice
    const trailingSpace = "a".repeat(MAX_CHAT_LENGTH - 2) + " 😀";
    expect(sanitiseChatText(trailingSpace)).toBe("a".repeat(MAX_CHAT_LENGTH - 2));

    // Exact MAX_CHAT_LENGTH ending in an unpaired high surrogate is returned intact
    const exactUnpairedHigh = "a".repeat(MAX_CHAT_LENGTH - 1) + "\uD800";
    expect(sanitiseChatText(exactUnpairedHigh)).toBe(exactUnpairedHigh);
    expect(sanitiseChatText(exactUnpairedHigh)).toHaveLength(MAX_CHAT_LENGTH);

    // Lower (0xD800 via U+10000) and upper (0xDBFF via U+10FFFF) high-surrogate boundaries at index MAX_CHAT_LENGTH - 1
    expect(sanitiseChatText("a".repeat(MAX_CHAT_LENGTH - 1) + "\u{10000}")).toBe(
      "a".repeat(MAX_CHAT_LENGTH - 1),
    );
    expect(sanitiseChatText("a".repeat(MAX_CHAT_LENGTH - 1) + "\u{10FFFF}")).toBe(
      "a".repeat(MAX_CHAT_LENGTH - 1),
    );
  });
});

describe("RoomChatRelay", () => {
  it("exposes expected burst and refill constants", () => {
    expect(CHAT_BURST).toBe(6);
    expect(CHAT_REFILL_PER_SEC).toBe(1.5);
  });

  it("ignores unjoined peers without broadcasting, erroring, or burning budget", () => {
    const relay = new RoomChatRelay();
    const unjoined = makePeer("p1", "alice", false);
    const joined = makePeer("p2", "bob", true);
    const host = makeHost([joined]);

    relay.handleChat(host, unjoined.ws, unjoined.att, { t: "chat", text: "hi" }, 1_000);
    expect(unjoined.sent).toEqual([]);
    expect(joined.sent).toEqual([]);

    // Once joined, full burst of 6 is still available
    unjoined.att.joined = true;
    const hostBoth = makeHost([unjoined, joined]);
    for (let i = 0; i < CHAT_BURST; i++) {
      relay.handleChat(hostBoth, unjoined.ws, unjoined.att, { t: "chat", text: `m${i}` }, 1_000);
    }
    expect(unjoined.sent.filter((m) => m.t === "chat")).toHaveLength(CHAT_BURST);
  });

  it("ignores empty-after-sanitise messages silently before consuming burst tokens", () => {
    const relay = new RoomChatRelay();
    const a = makePeer("p1", "alice");
    const host = makeHost([a]);

    relay.handleChat(host, a.ws, a.att, { t: "chat", text: "   " }, 1_000);
    relay.handleChat(host, a.ws, a.att, { t: "chat", text: "\u0007\u202E" }, 1_000);
    expect(a.sent).toEqual([]);

    // All 6 burst tokens remain available
    for (let i = 0; i < CHAT_BURST; i++) {
      relay.handleChat(host, a.ws, a.att, { t: "chat", text: `ok-${i}` }, 1_000);
    }
    expect(a.sent.filter((m) => m.t === "chat")).toHaveLength(CHAT_BURST);
  });

  it("broadcasts authoritative chat message to every joined peer including sender and defaults empty name", () => {
    const relay = new RoomChatRelay();
    const a = makePeer("p1", "");
    const b = makePeer("p2", "bob");
    const host = makeHost([a, b]);

    relay.handleChat(host, a.ws, a.att, { t: "chat", text: "  hello \n team  " }, 42_000);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(a.sent[0]).toEqual(b.sent[0]);
    expect(a.sent[0]).toMatchObject({
      t: "chat",
      from: "p1",
      name: "Anonymous",
      text: "hello team",
      ts: 42_000,
    });
    expect((a.sent[0] as { id: string }).id.length).toBeGreaterThan(0);
  });

  it("enforces token bucket burst, refill math, per-peer isolation, and forget()", () => {
    const relay = new RoomChatRelay();
    const a = makePeer("p1", "alice");
    const b = makePeer("p2", "bob");
    const host = makeHost([a, b]);

    // Exhaust p1's burst of 6
    for (let i = 0; i < CHAT_BURST; i++) {
      relay.handleChat(host, a.ws, a.att, { t: "chat", text: `msg-${i}` }, 10_000);
    }
    expect(a.sent.filter((m) => m.t === "chat")).toHaveLength(6);

    // 7th message at same timestamp is rate-limited only for p1
    relay.handleChat(host, a.ws, a.att, { t: "chat", text: "too-fast" }, 10_000);
    expect(a.sent[6]).toEqual({
      t: "error",
      code: "chat-rate-limited",
      message: "You're sending messages too fast. Wait a moment.",
    });
    expect(b.sent.filter((m) => m.t === "error")).toHaveLength(0);

    // p2 has independent budget
    relay.handleChat(host, b.ws, b.att, { t: "chat", text: "from-bob" }, 10_000);
    expect(a.sent.some((m) => m.t === "chat" && m.from === "p2")).toBe(true);

    // +500ms = 0.75 tokens (< 1) -> still rate-limited
    relay.handleChat(host, a.ws, a.att, { t: "chat", text: "still-fast" }, 10_500);
    expect(a.sent.filter((m) => m.t === "error")).toHaveLength(2);

    // +200ms more (total +700ms = 1.05 tokens >= 1) -> allowed
    relay.handleChat(host, a.ws, a.att, { t: "chat", text: "allowed-again" }, 10_700);
    expect(a.sent.some((m) => m.t === "chat" && m.text === "allowed-again")).toBe(true);

    // +4000ms caps refill at CHAT_BURST (6)
    const beforeBurst = a.sent.filter((m) => m.t === "chat").length;
    for (let i = 0; i < CHAT_BURST + 1; i++) {
      relay.handleChat(host, a.ws, a.att, { t: "chat", text: `refilled-${i}` }, 14_700);
    }
    expect(a.sent.filter((m) => m.t === "chat").length - beforeBurst).toBe(CHAT_BURST);

    // forget(peerId) resets budget at the same timestamp
    relay.forget("p1");
    const beforeForget = a.sent.filter((m) => m.t === "chat").length;
    for (let i = 0; i < CHAT_BURST; i++) {
      relay.handleChat(host, a.ws, a.att, { t: "chat", text: `after-forget-${i}` }, 14_700);
    }
    expect(a.sent.filter((m) => m.t === "chat").length - beforeForget).toBe(CHAT_BURST);
  });
});
