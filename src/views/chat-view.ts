import { MAX_CHAT_LENGTH, type ChatMessage, type PeerId } from "@shared/protocol";
import {
  ChatController,
  MAX_CHAT_MESSAGES,
  formatChatTime,
  type ChatEntry,
} from "../controllers/chat-controller";
import { createIcon } from "./icons";
import "./chat.css";

const NEAR_BOTTOM_PX = 24;
const NOTICE_DURATION_MS = 4_000;

export interface ChatFeatureDeps {
  stage: HTMLElement;
  roomBar: HTMLElement;
  getSelfId: () => PeerId | null;
  sendMessage: (text: string) => boolean;
  hasOpenPopover: () => boolean;
}

export interface ChatFeatureHandle {
  onMessage: (msg: ChatMessage) => void;
  onRateLimited: (friendly: string) => void;
  syncConnected: (connected: boolean) => void;
  syncReady: (ready: boolean) => void;
  reset: () => void;
}

interface ChatDomRefs {
  workspace: HTMLDivElement;
  panel: HTMLElement;
  closeBtn: HTMLButtonElement;
  emptyEl: HTMLDivElement;
  messagesEl: HTMLDivElement;
  noticeEl: HTMLParagraphElement;
  input: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  chatBtn: HTMLButtonElement;
  badgeEl: HTMLSpanElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function trimToMaxChatLength(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_CHAT_LENGTH) return trimmed;
  let end = MAX_CHAT_LENGTH;
  const code = trimmed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return trimmed.slice(0, end).trimEnd();
}

function isNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
}

function buildMessageNode(entry: ChatEntry): HTMLDivElement {
  const row = el("div", entry.self ? "chat-msg is-self" : "chat-msg");
  const meta = el("div", "chat-msg-meta");
  const name = el("span", "chat-msg-name", entry.name);
  const shortId = el("span", "chat-msg-id", entry.shortId);
  const sep = el("span", "chat-msg-sep", "\u00b7");
  sep.setAttribute("aria-hidden", "true");
  const time = el("time", "chat-msg-time", formatChatTime(entry.ts));
  meta.append(name, shortId, sep, time);

  const body = el("p", "chat-msg-text", entry.text);
  row.append(meta, body);
  return row;
}

function buildHeader(): { header: HTMLDivElement; closeBtn: HTMLButtonElement } {
  const header = el("div", "chat-header");
  const title = el("h2", undefined, "Room chat");
  title.id = "chat-title";
  const closeBtn = el("button");
  closeBtn.type = "button";
  closeBtn.id = "chat-close";
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.title = "Close chat";
  closeBtn.append(createIcon("close"));
  header.append(title, closeBtn);
  return { header, closeBtn };
}

function buildChatDom(): ChatDomRefs {
  const workspace = el("div", "chat-workspace");
  workspace.hidden = true;

  const panel = el("aside");
  panel.id = "chat-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Room chat");

  const { header, closeBtn } = buildHeader();

  const emptyEl = el("div", "chat-empty");
  emptyEl.id = "chat-empty";
  emptyEl.append(
    el("p", "chat-empty-title", "No messages yet"),
    el("p", "chat-empty-sub", "Messages are live-only and aren't saved after you leave."),
  );

  const messagesEl = el("div", "chat-messages");
  messagesEl.id = "chat-messages";
  messagesEl.hidden = true;
  messagesEl.setAttribute("role", "log");
  messagesEl.setAttribute("aria-live", "polite");
  messagesEl.setAttribute("aria-relevant", "additions");

  const noticeEl = el("p");
  noticeEl.id = "chat-notice";
  noticeEl.hidden = true;
  noticeEl.setAttribute("role", "status");
  noticeEl.setAttribute("aria-live", "polite");

  const composer = el("div", "chat-composer");
  const input = el("input", "ui-input chat-input");
  input.id = "chat-input";
  input.type = "text";
  input.maxLength = MAX_CHAT_LENGTH;
  input.autocomplete = "off";
  input.placeholder = "Not connected";
  input.disabled = true;
  input.setAttribute("aria-label", "Message room");

  const sendBtn = el("button", "ui-btn primary", "Send");
  sendBtn.id = "chat-send";
  sendBtn.type = "button";
  sendBtn.disabled = true;
  composer.append(input, sendBtn);

  panel.append(header, emptyEl, messagesEl, noticeEl, composer);

  const chatBtn = el("button", "ui-btn");
  chatBtn.id = "chat-btn";
  chatBtn.type = "button";
  chatBtn.hidden = true;
  chatBtn.setAttribute("aria-expanded", "false");
  chatBtn.setAttribute("aria-controls", "chat-panel");
  chatBtn.setAttribute("aria-label", "Room chat");
  chatBtn.title = "Toggle room chat";

  const label = el("span", "chat-btn-label", "Chat");
  const badgeEl = el("span", "chat-unread-badge");
  badgeEl.id = "chat-unread-badge";
  badgeEl.hidden = true;
  badgeEl.setAttribute("aria-hidden", "true");
  chatBtn.append(createIcon("chat"), label, badgeEl);

  return { workspace, panel, closeBtn, emptyEl, messagesEl, noticeEl, input, sendBtn, chatBtn, badgeEl };
}

export function mountChatFeature(deps: ChatFeatureDeps): ChatFeatureHandle {
  const dom = buildChatDom();
  const stageParent = deps.stage.parentNode;
  if (stageParent) {
    stageParent.insertBefore(dom.workspace, deps.stage);
  }
  dom.workspace.append(deps.stage, dom.panel);
  deps.roomBar.append(dom.chatBtn);

  const ctrl = new ChatController();
  let connected = false;
  let ready = false;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const syncComposer = (): void => {
    dom.input.disabled = !connected;
    dom.sendBtn.disabled = !connected || !ready;
    dom.input.placeholder = !connected ? "Not connected" : ready ? "Message room\u2026" : "Reconnecting\u2026";
  };

  const syncUnread = (): void => {
    const label = ctrl.unreadLabel();
    const hasUnread = label.length > 0;
    dom.badgeEl.textContent = label;
    dom.badgeEl.hidden = !hasUnread;
    dom.chatBtn.classList.toggle("has-unread", hasUnread);
    dom.chatBtn.setAttribute("aria-label", hasUnread ? `Room chat (${label} unread)` : "Room chat");
  };

  const syncMessageVisibility = (): void => {
    const hasMessages = ctrl.messages.length > 0;
    dom.emptyEl.hidden = hasMessages;
    dom.messagesEl.hidden = !hasMessages;
  };

  const syncDrawer = (returnFocus: boolean): void => {
    const open = connected && ctrl.open;
    dom.panel.hidden = !open;
    document.body.classList.toggle("chat-open", open);
    dom.chatBtn.setAttribute("aria-expanded", String(open));
    syncUnread();
    if (open) {
      dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
    } else if (returnFocus && connected) {
      dom.chatBtn.focus();
    }
  };

  const clearNotice = (): void => {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    dom.noticeEl.textContent = "";
    dom.noticeEl.hidden = true;
  };

  const submit = (): void => {
    if (!connected || !ready) return;
    const text = trimToMaxChatLength(dom.input.value);
    if (!text) return;
    if (deps.sendMessage(text)) {
      dom.input.value = "";
    }
  };

  dom.chatBtn.addEventListener("click", () => {
    if (!connected) return;
    const open = ctrl.toggle();
    syncDrawer(false);
    if (open) dom.input.focus();
  });

  dom.closeBtn.addEventListener("click", () => {
    ctrl.setOpen(false);
    syncDrawer(true);
  });

  dom.sendBtn.addEventListener("click", submit);

  dom.input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      submit();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !ctrl.open || deps.hasOpenPopover() || document.fullscreenElement !== null) return;
    ctrl.setOpen(false);
    syncDrawer(true);
  });

  return {
    onMessage: (msg) => {
      const wasNearBottom = ctrl.open && isNearBottom(dom.messagesEl);
      const entry = ctrl.receive(msg, deps.getSelfId());
      if (!entry) return;
      dom.messagesEl.append(buildMessageNode(entry));
      while (dom.messagesEl.childElementCount > MAX_CHAT_MESSAGES) {
        dom.messagesEl.firstElementChild?.remove();
      }
      syncMessageVisibility();
      syncUnread();
      if (ctrl.open && (wasNearBottom || entry.self)) {
        dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
      }
    },

    onRateLimited: (friendly) => {
      clearNotice();
      dom.noticeEl.textContent = friendly;
      dom.noticeEl.hidden = false;
      noticeTimer = setTimeout(clearNotice, NOTICE_DURATION_MS);
    },

    syncConnected: (next) => {
      if (connected === next) return;
      connected = next;
      dom.workspace.hidden = !connected;
      dom.chatBtn.hidden = !connected;
      if (!connected) {
        ready = false;
        ctrl.setOpen(false);
      }
      syncDrawer(false);
      syncComposer();
    },

    syncReady: (next) => {
      if (ready === next) return;
      ready = next;
      syncComposer();
    },

    reset: () => {
      clearNotice();
      ctrl.reset();
      ready = false;
      dom.messagesEl.replaceChildren();
      syncMessageVisibility();
      dom.input.value = "";
      syncDrawer(false);
      syncComposer();
    },
  };
}
