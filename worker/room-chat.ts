import { MAX_CHAT_LENGTH, type ServerMessage } from "@shared/protocol";
import { sendSafe } from "./room-policy";
import { spendBudget, type MessageBudget, type PeerAttachment } from "./room-models";

export const CHAT_BURST = 6;
export const CHAT_REFILL_PER_SEC = 1.5;

export interface ChatRelayHost {
  joinedPeers(): ReadonlyArray<{ ws: WebSocket }>;
}

const CHAT_CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Normalise user chat text: strip control/line-separator/bidi characters while
 * preserving ZWJ and variation selectors, collapse whitespace, trim, and clamp
 * to MAX_CHAT_LENGTH UTF-16 code units without splitting a surrogate pair.
 */
export function sanitiseChatText(raw: string): string {
  const cleaned = raw.replace(CHAT_CONTROL_RE, "").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= MAX_CHAT_LENGTH) return cleaned;
  const last = cleaned.charCodeAt(MAX_CHAT_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_CHAT_LENGTH - 1 : MAX_CHAT_LENGTH;
  return cleaned.slice(0, end).trimEnd();
}

export class RoomChatRelay {
  private readonly budgets: Map<string, MessageBudget> = new Map<string, MessageBudget>();

  forget(peerId: string): void {
    this.budgets.delete(peerId);
  }

  handleChat(
    host: ChatRelayHost,
    ws: WebSocket,
    attachment: PeerAttachment,
    msg: { t: "chat"; text: string },
    now: number = Date.now(),
  ): void {
    if (!attachment.joined) return;
    const text = sanitiseChatText(msg.text);
    if (!text) return;

    const res = spendBudget(this.budgets.get(attachment.id), now, CHAT_BURST, CHAT_REFILL_PER_SEC);
    this.budgets.set(attachment.id, res.budget);
    if (!res.allowed) {
      sendSafe(ws, {
        t: "error",
        code: "chat-rate-limited",
        message: "You're sending messages too fast. Wait a moment.",
      });
      return;
    }

    const out: ServerMessage = {
      t: "chat",
      id: crypto.randomUUID(),
      from: attachment.id,
      name: attachment.name || "Anonymous",
      text,
      ts: now,
    };
    for (const { ws: peerWs } of host.joinedPeers()) {
      sendSafe(peerWs, out);
    }
  }
}
