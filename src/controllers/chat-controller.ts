import type { ChatMessage, PeerId } from "@shared/protocol";

export const MAX_CHAT_MESSAGES: number = 200;

export interface ChatEntry {
  id: string;
  from: PeerId;
  shortId: string;
  name: string;
  text: string;
  ts: number;
  self: boolean;
}

/** Format a Unix millisecond timestamp as local `HH:MM` (or `"--:--"` if invalid). */
export function formatChatTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Pure, DOM-free controller for room chat state: bounded 200-message ring buffer,
 * deduplication via `seenIds`, unread tracking, and drawer open/close state.
 */
export class ChatController {
  private isOpen = false;
  private unread = 0;
  private readonly entries: ChatEntry[] = [];
  private readonly seen = new Set<string>();

  get open(): boolean {
    return this.isOpen;
  }

  get messages(): readonly ChatEntry[] {
    return this.entries;
  }

  get unreadCount(): number {
    return this.unread;
  }

  get seenIds(): ReadonlySet<string> {
    return this.seen;
  }

  receive(msg: ChatMessage, selfId: PeerId | null): ChatEntry | null {
    if (this.seen.has(msg.id)) return null;
    const self = msg.from === selfId;
    const entry: ChatEntry = {
      id: msg.id,
      from: msg.from,
      shortId: `#${msg.from.slice(0, 4)}`,
      name: msg.name.trim() || "Anonymous",
      text: msg.text,
      ts: msg.ts,
      self,
    };
    if (this.entries.length >= MAX_CHAT_MESSAGES) {
      for (const evicted of this.entries.splice(0, 1)) {
        this.seen.delete(evicted.id);
      }
    }
    this.entries.push(entry);
    this.seen.add(entry.id);
    if (!this.isOpen && !self) {
      this.unread++;
    }
    return entry;
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
    if (open) {
      this.unread = 0;
    }
  }

  toggle(): boolean {
    this.setOpen(!this.isOpen);
    return this.isOpen;
  }

  unreadLabel(): string {
    if (this.unread === 0) return "";
    if (this.unread > 99) return "99+";
    return String(this.unread);
  }

  reset(): void {
    this.entries.length = 0;
    this.seen.clear();
    this.unread = 0;
    this.isOpen = false;
  }
}
